import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';


const TEST_CONFIG = '{"operator":"moloch","token":"asdf","lhost":"localhost","lport":31337,"ca_certificate":"-----BEGIN CERTIFICATE-----\\nMIIBkTCCARigAwIBAgIQVkp7r+22F+SZwHlQ+1ZvCzAKBggqhkjOPQQDAzALMQkw\\nBwYDVQQKEwAwHhcNMjAwMTEwMDA1NDE2WhcNMjMwMTA5MDA1NDE2WjALMQkwBwYD\\nVQQKEwAwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAATssLf47lHL+LF7Yp9L5FnmKd6s\\nbP155fLQtQs/62Ft39QxZYNL4E/gWVJAECqlcvX7U3oaDabo2STNKrFiO+NzUcXF\\nPI6jCKeaM+hnBs9ZtNoGUlteUMJqPLLCHPaVrKKjQTA/MA4GA1UdDwEB/wQEAwIC\\npDAPBgNVHSUECDAGBgRVHSUAMA8GA1UdEwEB/wQFMAMBAf8wCwYDVR0RBAQwAoIA\\nMAoGCCqGSM49BAMDA2cAMGQCMANTLo/RDRqoFJDGlCTMkdWSUhcIwU0ldCQ8jQ7D\\nIVXvCJIyCLlJatbOdN65xisjuQIwFgyIli0HoRfabUI8mv+VBM+/mYBLBzMKkVhS\\n26ES7rMecXqG/upeeOpSMVOFiGQA\\n-----END CERTIFICATE-----\\n","private_key":"-----BEGIN EC PRIVATE KEY-----\\nMIGkAgEBBDAmiZa3NBtXUlOIGoMrLy5KtUPTVpL2Gjdmk0UU/cjALMydHotMiZVw\\n7Zwh90DGWkmgBwYFK4EEACKhZANiAASja0PvVtb7k3W7QdqqEqJhIVliHQ0vCaFI\\nfypSZJEr1AKfASkBQOx2OIrfpPkA6rkRK1oPTThx3mGENHN+nj+86eNOO22CmWmc\\nWLwUaywrEHBH+CDPSmFu2c6kyGs6yRE=\\n-----END EC PRIVATE KEY-----\\n","certificate":"-----BEGIN CERTIFICATE-----\\nMIIBiTCCAQ+gAwIBAgIQOIQlbcx090T/cfhKyqXmPzAKBggqhkjOPQQDAzALMQkw\\nBwYDVQQKEwAwHhcNMTkwNDE2MTY0ODIwWhcNMjIwNDE1MTY0ODIwWjAcMQkwBwYD\\nVQQKEwAxDzANBgNVBAMTBm1vbG9jaDB2MBAGByqGSM49AgEGBSuBBAAiA2IABKNr\\nQ+9W1vuTdbtB2qoSomEhWWIdDS8JoUh/KlJkkSvUAp8BKQFA7HY4it+k+QDquREr\\nWg9NOHHeYYQ0c36eP7zp4047bYKZaZxYvBRrLCsQcEf4IM9KYW7ZzqTIazrJEaMn\\nMCUwDgYDVR0PAQH/BAQDAgWgMBMGA1UdJQQMMAoGCCsGAQUFBwMCMAoGCCqGSM49\\nBAMDA2gAMGUCMQC8HmNeIWcWsbouOWm8XenJOK2Uyca/tGcTLXm5MiJPdZ7dtJLc\\nVIt5htl/PkkZtTgCMC6K0RDVtdpHTgNOkHW1gW6yNeR64eCBLwykG9EQKshgWFUs\\nEX873XAQ+PnC8r2oZg==\\n-----END CERTIFICATE-----\\n"}';


import { ParseConfig } from '../config'; 

const SERVER_PUBLIC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const CLIENT_PRIVATE_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const CLIENT_PUBLIC_KEY = '2222222222222222222222222222222222222222222222222222222222222222';
const PRESHARED_KEY = '1111111111111111111111111111111111111111111111111111111111111111';

test('ParseConfig', () => {
    expect(ParseConfig(Buffer.from(TEST_CONFIG)).operator).toBe('moloch');
    expect(ParseConfig(Buffer.from(TEST_CONFIG)).lhost).toBe('localhost');
    expect(ParseConfig(Buffer.from(TEST_CONFIG)).lport).toBe(31337);
});

import { ParseConfigFile } from '../config'; 

test('ParseConfigFile', async () => {
    const configPath = path.join(os.tmpdir(), `sliver-script-test-${Math.random()}`);
    fs.writeFileSync(configPath, Buffer.from(TEST_CONFIG), {mode: 0o600});
    const config = await ParseConfigFile(configPath);
    expect(config.operator).toBe('moloch');
    expect(config.lhost).toBe('localhost');
    expect(config.lport).toBe(31337);
    expect(config.token).toBe('asdf');
    fs.unlinkSync(configPath);
});

test('ParseConfig accepts optional wg block', () => {
    const config = ParseConfig(Buffer.from(JSON.stringify({
        operator: 'moloch',
        token: 'asdf',
        lhost: 'localhost',
        lport: 31337,
        ca_certificate: 'ca',
        private_key: 'key',
        certificate: 'cert',
        wg: {
            enabled: true,
            server_pub_key: SERVER_PUBLIC_KEY,
            client_private_key: CLIENT_PRIVATE_KEY,
            client_pub_key: CLIENT_PUBLIC_KEY,
            preshared_key: PRESHARED_KEY,
            client_ip: '100.65.0.2',
            server_ip: '100.65.0.1',
        },
    })));

    expect(config.wg?.server_pub_key).toBe(SERVER_PUBLIC_KEY);
    expect(config.wg?.client_ip).toBe('100.65.0.2');
    expect(config.wg?.enabled).toBe(true);
});

test.each([0, -1, 65_536, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'ParseConfig rejects invalid operator port %p',
    (lport) => {
        const parsed = JSON.parse(TEST_CONFIG) as Record<string, unknown>;
        parsed.lport = lport;
        expect(() => ParseConfig(Buffer.from(JSON.stringify(parsed)))).toThrow(/invalid lport/u);
    },
);

test.each(['server_pub_key', 'client_private_key', 'client_ip'] as const)(
    'ParseConfig requires non-empty wg.%s when WireGuard is enabled',
    (missingKey) => {
        const parsed = JSON.parse(TEST_CONFIG) as Record<string, any>;
        parsed.wg = {
            enabled: true,
            server_pub_key: SERVER_PUBLIC_KEY,
            client_private_key: CLIENT_PRIVATE_KEY,
            client_ip: '100.65.0.2',
        };
        parsed.wg[missingKey] = ' ';
        expect(() => ParseConfig(Buffer.from(JSON.stringify(parsed)))).toThrow(
            new RegExp(`invalid wg\\.${missingKey}`, 'u'),
        );
    },
);

test.each([
    ['server_pub_key', 'abcd'],
    ['client_private_key', 'z'.repeat(64)],
    ['client_pub_key', `${'a'.repeat(64)}\nprivate_key=attacker`],
    ['preshared_key', 'g'.repeat(64)],
] as const)('ParseConfig rejects malformed or injected wg.%s', (field, value) => {
    const parsed = JSON.parse(TEST_CONFIG) as Record<string, any>;
    parsed.wg = {
        enabled: true,
        server_pub_key: SERVER_PUBLIC_KEY,
        client_private_key: CLIENT_PRIVATE_KEY,
        client_pub_key: CLIENT_PUBLIC_KEY,
        preshared_key: PRESHARED_KEY,
        client_ip: '100.65.0.2',
        server_ip: '100.65.0.1',
        [field]: value,
    };
    expect(() => ParseConfig(Buffer.from(JSON.stringify(parsed)))).toThrow(/exactly 64 hexadecimal characters/u);
});

test.each(['server_pub_key', 'client_private_key', 'client_pub_key', 'preshared_key'] as const)(
    'ParseConfig rejects an all-zero wg.%s',
    (field) => {
        const parsed = JSON.parse(TEST_CONFIG) as Record<string, any>;
        parsed.wg = {
            enabled: true,
            server_pub_key: SERVER_PUBLIC_KEY,
            client_private_key: CLIENT_PRIVATE_KEY,
            client_pub_key: CLIENT_PUBLIC_KEY,
            preshared_key: PRESHARED_KEY,
            client_ip: '100.65.0.2',
            server_ip: '100.65.0.1',
            [field]: '0'.repeat(64),
        };
        expect(() => ParseConfig(Buffer.from(JSON.stringify(parsed)))).toThrow(/all-zero WireGuard key/u);
    },
);

test.each(['fe80::1%lo0', '::ffff:192.0.2.1', '0:0:0:0:0:ffff:c000:201', '100.65.0.2/24'])(
    'ParseConfig rejects unsupported WireGuard address %s',
    (clientIP) => {
        const parsed = JSON.parse(TEST_CONFIG) as Record<string, any>;
        parsed.wg = {
            enabled: true,
            server_pub_key: SERVER_PUBLIC_KEY,
            client_private_key: CLIENT_PRIVATE_KEY,
            client_ip: clientIP,
            server_ip: clientIP.includes(':') ? 'fd00::1' : '100.65.0.1',
        };
        expect(() => ParseConfig(Buffer.from(JSON.stringify(parsed)))).toThrow(/valid IP address or prefix/u);
    },
);

test('ParseConfig requires a complete WireGuard block even when disabled', () => {
    const parsed = JSON.parse(TEST_CONFIG) as Record<string, unknown>;
    parsed.wg = { enabled: false };
    expect(() => ParseConfig(Buffer.from(JSON.stringify(parsed)))).toThrow(/invalid wg\.server_pub_key/u);
});

test('ParseConfig rejects a WireGuard client/server address-family mismatch', () => {
    const parsed = JSON.parse(TEST_CONFIG) as Record<string, any>;
    parsed.wg = {
        enabled: true,
        server_pub_key: SERVER_PUBLIC_KEY,
        client_private_key: CLIENT_PRIVATE_KEY,
        client_ip: 'fd00::2',
        server_ip: '100.65.0.1',
    };
    expect(() => ParseConfig(Buffer.from(JSON.stringify(parsed)))).toThrow(/same address family/u);
});
