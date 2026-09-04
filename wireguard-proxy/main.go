// sliver-script-wgproxy exposes a loopback TCP bridge to the Sliver
// multiplayer listener through an in-process WireGuard netstack.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
)

const (
	defaultServerIP       = "100.65.0.1"
	wireGuardMTU          = 1420
	wireGuardKeepalive    = 25
	configMaximumBytes    = 1 << 20
	endpointLookupTimeout = 10 * time.Second
	innerDialTimeout      = 30 * time.Second
	maximumConnections    = 64
	proxyCopyBufferBytes  = 64 * 1024
)

type clientConfig struct {
	LHost string           `json:"lhost"`
	LPort int              `json:"lport"`
	WG    *wireGuardConfig `json:"wg"`
}

type wireGuardConfig struct {
	ServerPublicKey  string `json:"server_pub_key"`
	ClientPrivateKey string `json:"client_private_key"`
	PresharedKey     string `json:"preshared_key,omitempty"`
	ClientIP         string `json:"client_ip"`
	ServerIP         string `json:"server_ip"`
}

type readyMessage struct {
	ListenHost string `json:"listen_host"`
	ListenPort int    `json:"listen_port"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "wireguard proxy: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	config, err := readConfig(os.Stdin)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// The parent deliberately keeps stdin open after the single configuration
	// frame. EOF is a portable parent-lifetime signal, including on Windows.
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		stop()
	}()

	endpoint, err := resolveEndpoint(config.LHost, config.LPort)
	if err != nil {
		return err
	}
	clientIP, serverIP, err := wireGuardAddresses(config.WG)
	if err != nil {
		return err
	}

	tun, tunnelNet, err := createTransportNetTUN([]netip.Addr{clientIP}, wireGuardMTU)
	if err != nil {
		return fmt.Errorf("create userspace network stack: %w", err)
	}

	dev := device.NewDevice(tun, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, "[sliver-script/wg] "))
	defer func() {
		dev.Close()
		<-dev.Wait()
	}()

	wgConfig := bytes.NewBuffer(nil)
	fmt.Fprintf(wgConfig, "private_key=%s\n", config.WG.ClientPrivateKey)
	fmt.Fprintf(wgConfig, "public_key=%s\n", config.WG.ServerPublicKey)
	if config.WG.PresharedKey != "" {
		fmt.Fprintf(wgConfig, "preshared_key=%s\n", config.WG.PresharedKey)
	}
	fmt.Fprintf(wgConfig, "endpoint=%s\n", endpoint)
	fmt.Fprintf(wgConfig, "allowed_ip=%s\n", allowedIP(serverIP))
	fmt.Fprintf(wgConfig, "persistent_keepalive_interval=%d\n", wireGuardKeepalive)
	ipcErr := consumeAndClear(wgConfig.Bytes(), dev.IpcSetOperation)
	wgConfig.Reset()
	if ipcErr != nil {
		return fmt.Errorf("configure wireguard device: %w", ipcErr)
	}
	if err := dev.Up(); err != nil {
		return fmt.Errorf("start wireguard device: %w", err)
	}

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen on loopback: %w", err)
	}
	defer listener.Close()

	tcpAddress, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		return errors.New("loopback listener returned an unexpected address")
	}
	if ctx.Err() != nil {
		return nil
	}
	if err := json.NewEncoder(os.Stdout).Encode(readyMessage{
		ListenHost: "127.0.0.1",
		ListenPort: tcpAddress.Port,
	}); err != nil {
		return fmt.Errorf("write startup response: %w", err)
	}
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()

	innerAddress := netip.AddrPortFrom(serverIP, uint16(config.LPort))
	var connections sync.WaitGroup
	connectionSlots := make(chan struct{}, maximumConnections)
	defer func() {
		stop()
		connections.Wait()
	}()
	for {
		local, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return fmt.Errorf("accept loopback connection: %w", err)
		}
		select {
		case connectionSlots <- struct{}{}:
		case <-ctx.Done():
			_ = local.Close()
			return nil
		default:
			_ = local.Close()
			continue
		}
		connections.Add(1)
		go func() {
			defer connections.Done()
			defer func() { <-connectionSlots }()
			proxyConnection(ctx, local, tunnelNet, innerAddress)
		}()
	}
}

func consumeAndClear(data []byte, consume func(io.Reader) error) error {
	defer clear(data)
	return consume(bytes.NewReader(data))
}

func readConfig(reader io.Reader) (*clientConfig, error) {
	limited := bufio.NewReader(io.LimitReader(reader, configMaximumBytes+2))
	data, err := limited.ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("read configuration: %w", err)
	}
	defer clear(data)
	data = bytes.TrimSuffix(data, []byte{'\n'})
	data = bytes.TrimSuffix(data, []byte{'\r'})
	if len(data) > configMaximumBytes {
		return nil, fmt.Errorf("configuration exceeds %d bytes", configMaximumBytes)
	}

	var config clientConfig
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return nil, errors.New("configuration is not valid JSON")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("configuration is not valid JSON")
	}
	if err := validateConfig(&config); err != nil {
		return nil, err
	}
	return &config, nil
}

func validateConfig(config *clientConfig) error {
	if config == nil {
		return errors.New("configuration is required")
	}
	if strings.TrimSpace(config.LHost) == "" {
		return errors.New("lhost is required")
	}
	if config.LPort < 1 || config.LPort > 65535 {
		return fmt.Errorf("lport %d is outside 1..65535", config.LPort)
	}
	if config.WG == nil {
		return errors.New("wg configuration is required")
	}
	missing := make([]string, 0, 3)
	if strings.TrimSpace(config.WG.ServerPublicKey) == "" {
		missing = append(missing, "server_pub_key")
	}
	if strings.TrimSpace(config.WG.ClientPrivateKey) == "" {
		missing = append(missing, "client_private_key")
	}
	if strings.TrimSpace(config.WG.ClientIP) == "" {
		missing = append(missing, "client_ip")
	}
	if len(missing) != 0 {
		return fmt.Errorf("incomplete wg configuration: missing %s", strings.Join(missing, ", "))
	}
	if err := validateWireGuardKey(config.WG.ServerPublicKey, "server_pub_key"); err != nil {
		return err
	}
	if err := validateWireGuardKey(config.WG.ClientPrivateKey, "client_private_key"); err != nil {
		return err
	}
	if config.WG.PresharedKey != "" {
		if err := validateWireGuardKey(config.WG.PresharedKey, "preshared_key"); err != nil {
			return err
		}
	}
	if _, _, err := wireGuardAddresses(config.WG); err != nil {
		return err
	}
	return nil
}

func validateWireGuardKey(value, field string) error {
	if len(value) != 64 {
		return fmt.Errorf("%s must be exactly 64 hexadecimal characters", field)
	}
	for _, character := range []byte(value) {
		if !((character >= '0' && character <= '9') ||
			(character >= 'a' && character <= 'f') ||
			(character >= 'A' && character <= 'F')) {
			return fmt.Errorf("%s must be exactly 64 hexadecimal characters", field)
		}
	}
	if value == strings.Repeat("0", 64) {
		return fmt.Errorf("%s must not be an all-zero wireguard key", field)
	}
	return nil
}

func wireGuardAddresses(config *wireGuardConfig) (netip.Addr, netip.Addr, error) {
	clientIP, err := parseConfigIP(config.ClientIP, "client_ip")
	if err != nil {
		return netip.Addr{}, netip.Addr{}, err
	}
	serverIPValue := config.ServerIP
	if serverIPValue == "" {
		serverIPValue = defaultServerIP
	}
	serverIP, err := parseConfigIP(serverIPValue, "server_ip")
	if err != nil {
		return netip.Addr{}, netip.Addr{}, err
	}
	if clientIP.Is6() != serverIP.Is6() {
		return netip.Addr{}, netip.Addr{}, errors.New("client_ip and server_ip must use the same address family")
	}
	return clientIP, serverIP, nil
}

func parseConfigIP(value, field string) (netip.Addr, error) {
	if value != strings.TrimSpace(value) {
		return netip.Addr{}, fmt.Errorf("%s is not a valid IP address", field)
	}
	if prefix, err := netip.ParsePrefix(value); err == nil {
		address := prefix.Addr()
		if prefix.Bits() != address.BitLen() || address.Zone() != "" || address.Is4In6() {
			return netip.Addr{}, fmt.Errorf("%s is not a valid host IP address or host prefix", field)
		}
		return address, nil
	}
	address, err := netip.ParseAddr(value)
	if err != nil || address.Zone() != "" || address.Is4In6() {
		return netip.Addr{}, fmt.Errorf("%s is not a valid IP address", field)
	}
	return address, nil
}

func resolveEndpoint(host string, port int) (netip.AddrPort, error) {
	host = strings.Trim(strings.TrimSpace(host), "[]")
	if address, err := netip.ParseAddr(host); err == nil {
		return netip.AddrPortFrom(address, uint16(port)), nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), endpointLookupTimeout)
	defer cancel()
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return netip.AddrPort{}, fmt.Errorf("resolve wireguard endpoint %q: %w", host, err)
	}
	for _, address := range addresses {
		if address.IsValid() {
			return netip.AddrPortFrom(address, uint16(port)), nil
		}
	}
	return netip.AddrPort{}, fmt.Errorf("wireguard endpoint %q has no usable IP address", host)
}

func allowedIP(address netip.Addr) string {
	if address.Is6() {
		return address.String() + "/128"
	}
	return address.String() + "/32"
}

func proxyConnection(ctx context.Context, local net.Conn, tunnelNet *transportNet, inner netip.AddrPort) {
	defer local.Close()
	dialContext, cancel := context.WithTimeout(ctx, innerDialTimeout)
	remote, err := tunnelNet.DialContextTCPAddrPort(dialContext, inner)
	cancel()
	if err != nil {
		return
	}
	defer remote.Close()
	closed := make(chan struct{})
	defer close(closed)
	go func() {
		select {
		case <-ctx.Done():
			_ = local.Close()
			_ = remote.Close()
		case <-closed:
		}
	}()

	var copies sync.WaitGroup
	copies.Add(2)
	go func() {
		defer copies.Done()
		_, _ = copyProxyStream(remote, local)
		_ = remote.CloseWrite()
	}()
	go func() {
		defer copies.Done()
		_, _ = copyProxyStream(local, remote)
		if tcp, ok := local.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
	}()
	copies.Wait()
}

// copyProxyStream uses an explicit bounded buffer rather than transport-
// specific io.Copy fast paths. The source and destination live in different
// network stacks (kernel TCP and gVisor TCP), so keeping the bridge generic
// avoids platform-specific splice behavior.
func copyProxyStream(destination io.Writer, source io.Reader) (int64, error) {
	buffer := make([]byte, proxyCopyBufferBytes)
	var total int64
	for {
		read, readErr := source.Read(buffer)
		if read > 0 {
			written := 0
			for written < read {
				count, writeErr := destination.Write(buffer[written:read])
				total += int64(count)
				written += count
				if writeErr != nil {
					return total, writeErr
				}
				if count == 0 {
					return total, io.ErrShortWrite
				}
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return total, nil
			}
			return total, readErr
		}
	}
}

func clear(data []byte) {
	for index := range data {
		data[index] = 0
	}
}
