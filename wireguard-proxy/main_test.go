package main

import (
	"bytes"
	"io"
	"net/netip"
	"strings"
	"syscall"
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
)

const (
	testServerPublicKey  = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	testClientPrivateKey = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
	testPresharedKey     = "1111111111111111111111111111111111111111111111111111111111111111"
)

func TestReadConfigAcceptsGeneratedOperatorWireGuardFields(t *testing.T) {
	config, err := readConfig(strings.NewReader(`{"lhost":"wireguard.example.test","lport":31337,"wg":{"server_pub_key":"` + testServerPublicKey + `","client_private_key":"` + testClientPrivateKey + `","preshared_key":"` + testPresharedKey + `","client_ip":"100.65.0.2/32","server_ip":"100.65.0.1"}}`))
	if err != nil {
		t.Fatalf("readConfig() error = %v", err)
	}
	if config.WG == nil || config.WG.ClientIP != "100.65.0.2/32" {
		t.Fatalf("readConfig() returned unexpected config: %#v", config)
	}
}

func TestReadConfigConsumesNewlineFrameWithoutWaitingForParentEOF(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()

	result := make(chan error, 1)
	go func() {
		_, err := readConfig(reader)
		result <- err
	}()
	_, err := io.WriteString(writer, `{"lhost":"127.0.0.1","lport":31337,"wg":{"server_pub_key":"`+testServerPublicKey+`","client_private_key":"`+testClientPrivateKey+`","client_ip":"100.65.0.2"}}`+"\n")
	if err != nil {
		t.Fatalf("write framed config: %v", err)
	}

	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("readConfig() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("readConfig() waited for EOF after a complete frame")
	}
}

func TestReadConfigRejectsIncompleteOrOversizedInputWithoutReflectingSecrets(t *testing.T) {
	const secret = "DO-NOT-REFLECT-PRIVATE-KEY"
	_, err := readConfig(strings.NewReader(`{
		"lhost":"127.0.0.1",
		"lport":31337,
		"wg":{"client_private_key":"` + secret + `"}
	}`))
	if err == nil {
		t.Fatal("readConfig() unexpectedly accepted an incomplete config")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("readConfig() reflected private key material: %v", err)
	}

	_, err = readConfig(bytes.NewReader(bytes.Repeat([]byte{'x'}, configMaximumBytes+1)))
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("readConfig() oversized error = %v", err)
	}
}

func TestReadConfigRejectsUnknownAndTrailingFields(t *testing.T) {
	valid := `{"lhost":"127.0.0.1","lport":31337,"wg":{"server_pub_key":"` + testServerPublicKey + `","client_private_key":"` + testClientPrivateKey + `","client_ip":"100.65.0.2"}}`
	for _, input := range []string{
		strings.TrimSuffix(valid, "}") + `,"token":"must-not-cross-boundary"}`,
		valid + `{}`,
	} {
		if _, err := readConfig(strings.NewReader(input)); err == nil {
			t.Fatalf("readConfig() unexpectedly accepted %s", input)
		}
	}
}

func TestParseConfigIPAcceptsAddressAndPrefix(t *testing.T) {
	for _, value := range []string{"100.65.0.2", "100.65.0.2/32", "fd00::2/128"} {
		if _, err := parseConfigIP(value, "client_ip"); err != nil {
			t.Fatalf("parseConfigIP(%q) error = %v", value, err)
		}
	}
}

func TestValidateConfigRejectsInvalidPort(t *testing.T) {
	config := &clientConfig{
		LHost: "127.0.0.1",
		LPort: 0,
		WG: &wireGuardConfig{
			ServerPublicKey:  testServerPublicKey,
			ClientPrivateKey: testClientPrivateKey,
			ClientIP:         "100.65.0.2",
		},
	}
	if err := validateConfig(config); err == nil {
		t.Fatal("validateConfig() unexpectedly accepted port zero")
	}
}

func TestReadConfigRejectsMalformedOrInjectedWireGuardKeys(t *testing.T) {
	valid := `{"lhost":"127.0.0.1","lport":31337,"wg":{"server_pub_key":"` + testServerPublicKey + `","client_private_key":"` + testClientPrivateKey + `","client_ip":"100.65.0.2"}}`
	tests := []struct {
		name  string
		input string
	}{
		{name: "short public key", input: strings.Replace(valid, testServerPublicKey, "abcd", 1)},
		{name: "non-hex private key", input: strings.Replace(valid, testClientPrivateKey, strings.Repeat("z", 64), 1)},
		{name: "directive injection", input: strings.Replace(valid, testServerPublicKey, strings.Repeat("a", 63)+`\nendpoint=attacker.example:1`, 1)},
		{name: "invalid preshared key", input: strings.Replace(valid, `"client_ip"`, `"preshared_key":"`+strings.Repeat("g", 64)+`","client_ip"`, 1)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := readConfig(strings.NewReader(test.input)); err == nil {
				t.Fatal("readConfig() unexpectedly accepted malformed key material")
			}
		})
	}
}

func TestReadConfigRejectsAllZeroWireGuardKeys(t *testing.T) {
	valid := `{"lhost":"127.0.0.1","lport":31337,"wg":{"server_pub_key":"` + testServerPublicKey + `","client_private_key":"` + testClientPrivateKey + `","preshared_key":"` + testPresharedKey + `","client_ip":"100.65.0.2"}}`
	for _, key := range []string{testServerPublicKey, testClientPrivateKey, testPresharedKey} {
		if _, err := readConfig(strings.NewReader(strings.Replace(valid, key, strings.Repeat("0", 64), 1))); err == nil || !strings.Contains(err.Error(), "all-zero") {
			t.Fatalf("readConfig() all-zero key error = %v", err)
		}
	}
}

func TestReadConfigRejectsMismatchedWireGuardAddressFamilies(t *testing.T) {
	input := `{"lhost":"127.0.0.1","lport":31337,"wg":{"server_pub_key":"` + testServerPublicKey + `","client_private_key":"` + testClientPrivateKey + `","client_ip":"fd00::2","server_ip":"100.65.0.1"}}`
	if _, err := readConfig(strings.NewReader(input)); err == nil || !strings.Contains(err.Error(), "same address family") {
		t.Fatalf("readConfig() family mismatch error = %v", err)
	}
}

func TestReadConfigRejectsWhitespaceOrDirectiveInjectedWireGuardAddresses(t *testing.T) {
	for _, clientIP := range []string{" 100.65.0.2", "100.65.0.2 ", `100.65.0.2\nallowed_ip=0.0.0.0/0`} {
		input := `{"lhost":"127.0.0.1","lport":31337,"wg":{"server_pub_key":"` + testServerPublicKey + `","client_private_key":"` + testClientPrivateKey + `","client_ip":"` + clientIP + `","server_ip":"100.65.0.1"}}`
		if _, err := readConfig(strings.NewReader(input)); err == nil {
			t.Fatalf("readConfig() unexpectedly accepted injected client_ip %q", clientIP)
		}
	}
}

func TestParseConfigIPRejectsZonesMappedAddressesAndNonHostPrefixes(t *testing.T) {
	for _, value := range []string{
		"fe80::1%lo0",
		"::ffff:192.0.2.1",
		"0:0:0:0:0:ffff:c000:201",
		"100.65.0.2/24",
		"fd00::2/64",
	} {
		if _, err := parseConfigIP(value, "client_ip"); err == nil {
			t.Fatalf("parseConfigIP(%q) unexpectedly succeeded", value)
		}
	}
}

func TestConsumeAndClearWipesConsumedConfiguration(t *testing.T) {
	for _, operationError := range []error{nil, io.ErrClosedPipe} {
		configuration := []byte("private_key=" + testClientPrivateKey + "\n")
		expected := bytes.Clone(configuration)
		err := consumeAndClear(configuration, func(reader io.Reader) error {
			consumed, readErr := io.ReadAll(reader)
			if readErr != nil {
				t.Fatalf("read configuration: %v", readErr)
			}
			if !bytes.Equal(consumed, expected) {
				t.Fatal("consumer did not receive the complete configuration")
			}
			return operationError
		})
		if err != operationError {
			t.Fatalf("consumeAndClear() error = %v, want %v", err, operationError)
		}
		if !bytes.Equal(configuration, make([]byte, len(configuration))) {
			t.Fatal("consumeAndClear() retained configuration bytes")
		}
	}
}

func TestCopyProxyStreamTransfersPayloadLargerThanNetworkBuffers(t *testing.T) {
	payload := bytes.Repeat([]byte("sliver-script-wireguard"), 150_000)
	var destination bytes.Buffer

	written, err := copyProxyStream(&destination, bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("copyProxyStream() error = %v", err)
	}
	if written != int64(len(payload)) {
		t.Fatalf("copyProxyStream() wrote %d bytes, expected %d", written, len(payload))
	}
	if !bytes.Equal(destination.Bytes(), payload) {
		t.Fatal("copyProxyStream() payload mismatch")
	}
}

func TestTransportTunWriteRejectsInvalidIPVersion(t *testing.T) {
	tun := &transportTun{ep: channel.New(1, 1420, "")}
	if _, err := tun.Write([][]byte{{0}}, 0); err != syscall.EAFNOSUPPORT {
		t.Fatalf("Write() error = %v, want %v", err, syscall.EAFNOSUPPORT)
	}
}

func TestTransportTunCloseUnblocksWriteNotify(t *testing.T) {
	device, _, err := createTransportNetTUN([]netip.Addr{netip.MustParseAddr("100.65.0.2")}, 1420)
	if err != nil {
		t.Fatalf("createTransportNetTUN() error = %v", err)
	}
	tun := device.(*transportTun)

	// Queue one outbound packet without invoking the registered synchronous
	// notification. WriteNotify will drain it and block on the unbuffered handoff
	// until Close signals the done channel.
	tun.ep.RemoveNotify(tun.notifyHandle)
	packet := stack.NewPacketBuffer(stack.PacketBufferOptions{
		Payload: buffer.MakeWithData([]byte{0x45, 0, 0, 20}),
	})
	var packets stack.PacketBufferList
	packets.PushBack(packet)
	written, tcpipErr := tun.ep.WritePackets(packets)
	packet.DecRef()
	if tcpipErr != nil || written != 1 {
		t.Fatalf("WritePackets() = (%d, %v), want (1, nil)", written, tcpipErr)
	}

	notified := make(chan struct{})
	go func() {
		defer close(notified)
		tun.WriteNotify()
	}()

	deadline := time.Now().Add(time.Second)
	for tun.ep.NumQueued() != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if tun.ep.NumQueued() != 0 {
		t.Fatal("WriteNotify() did not drain the queued packet")
	}
	select {
	case <-notified:
		t.Fatal("WriteNotify() returned before Close() signaled shutdown")
	default:
	}

	if err := tun.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	select {
	case <-notified:
	case <-time.After(time.Second):
		t.Fatal("Close() did not unblock WriteNotify()")
	}
	if err := tun.Close(); err != nil {
		t.Fatalf("second Close() error = %v", err)
	}
}
