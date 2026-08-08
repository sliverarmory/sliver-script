import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';


const TEST_CONFIG = '{"operator":"moloch","token":"asdf","lhost":"localhost","lport":31337,"ca_certificate":"-----BEGIN CERTIFICATE-----\\nMIIBkTCCARigAwIBAgIQVkp7r+22F+SZwHlQ+1ZvCzAKBggqhkjOPQQDAzALMQkw\\nBwYDVQQKEwAwHhcNMjAwMTEwMDA1NDE2WhcNMjMwMTA5MDA1NDE2WjALMQkwBwYD\\nVQQKEwAwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAATssLf47lHL+LF7Yp9L5FnmKd6s\\nbP155fLQtQs/62Ft39QxZYNL4E/gWVJAECqlcvX7U3oaDabo2STNKrFiO+NzUcXF\\nPI6jCKeaM+hnBs9ZtNoGUlteUMJqPLLCHPaVrKKjQTA/MA4GA1UdDwEB/wQEAwIC\\npDAPBgNVHSUECDAGBgRVHSUAMA8GA1UdEwEB/wQFMAMBAf8wCwYDVR0RBAQwAoIA\\nMAoGCCqGSM49BAMDA2cAMGQCMANTLo/RDRqoFJDGlCTMkdWSUhcIwU0ldCQ8jQ7D\\nIVXvCJIyCLlJatbOdN65xisjuQIwFgyIli0HoRfabUI8mv+VBM+/mYBLBzMKkVhS\\n26ES7rMecXqG/upeeOpSMVOFiGQA\\n-----END CERTIFICATE-----\\n","private_key":"-----BEGIN EC PRIVATE KEY-----\\nMIGkAgEBBDAmiZa3NBtXUlOIGoMrLy5KtUPTVpL2Gjdmk0UU/cjALMydHotMiZVw\\n7Zwh90DGWkmgBwYFK4EEACKhZANiAASja0PvVtb7k3W7QdqqEqJhIVliHQ0vCaFI\\nfypSZJEr1AKfASkBQOx2OIrfpPkA6rkRK1oPTThx3mGENHN+nj+86eNOO22CmWmc\\nWLwUaywrEHBH+CDPSmFu2c6kyGs6yRE=\\n-----END EC PRIVATE KEY-----\\n","certificate":"-----BEGIN CERTIFICATE-----\\nMIIBiTCCAQ+gAwIBAgIQOIQlbcx090T/cfhKyqXmPzAKBggqhkjOPQQDAzALMQkw\\nBwYDVQQKEwAwHhcNMTkwNDE2MTY0ODIwWhcNMjIwNDE1MTY0ODIwWjAcMQkwBwYD\\nVQQKEwAxDzANBgNVBAMTBm1vbG9jaDB2MBAGByqGSM49AgEGBSuBBAAiA2IABKNr\\nQ+9W1vuTdbtB2qoSomEhWWIdDS8JoUh/KlJkkSvUAp8BKQFA7HY4it+k+QDquREr\\nWg9NOHHeYYQ0c36eP7zp4047bYKZaZxYvBRrLCsQcEf4IM9KYW7ZzqTIazrJEaMn\\nMCUwDgYDVR0PAQH/BAQDAgWgMBMGA1UdJQQMMAoGCCsGAQUFBwMCMAoGCCqGSM49\\nBAMDA2gAMGUCMQC8HmNeIWcWsbouOWm8XenJOK2Uyca/tGcTLXm5MiJPdZ7dtJLc\\nVIt5htl/PkkZtTgCMC6K0RDVtdpHTgNOkHW1gW6yNeR64eCBLwykG9EQKshgWFUs\\nEX873XAQ+PnC8r2oZg==\\n-----END CERTIFICATE-----\\n"}';


import { ParseConfig } from '../config'; 

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
            server_pub_key: 'server',
            client_private_key: 'private',
            client_pub_key: 'public',
            client_ip: '100.65.0.2',
            server_ip: '100.65.0.1',
        },
    })));

    expect(config.wg?.server_pub_key).toBe('server');
    expect(config.wg?.client_ip).toBe('100.65.0.2');
});
