//import { SliverClient } from '../../src/client'
//import { ParseConfigFile } from '../../src/config'

// Use this import when using the NPM module, and remove the relative imports above:
import { SliverClient, ParseConfigFile } from 'sliver-script';

import * as os from 'os'
import * as path from 'path'


const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.sliver-client', 'configs', 'default.cfg')
const SLIVER_CONFIG_FILE = process.env['SLIVER_CONFIG_FILE'] || DEFAULT_CONFIG_PATH;


(async () => {
    console.log(`Loading config: ${SLIVER_CONFIG_FILE}`)
    const config = await ParseConfigFile(SLIVER_CONFIG_FILE)
    const client = new SliverClient(config)

    console.log(`Connecting to ${config.lhost} ...`)
    try {
        await client.connect();
    } catch (err) {
        console.error(err)
        process.exit(9)
    }

    const sessions = await client.sessions()
    if (!sessions) {
        console.error(`No sessions found`)
        process.exit(3)
    }
    console.log(sessions);
    if (0 < sessions.length) {
        const interact = client.interactSession(sessions[0].ID)
        const shell = await interact.shell('/bin/bash', true)
        shell.stdout$.subscribe(data => {
            process.stdout.write(data)
        }, (err) => {
            console.error(err)
        }, () => {
            console.log('tunnel closed')
        });
        shell.write('ls\n')
        shell.write('exit\n')
        setTimeout(() => { process.exit(0) }, 1000)
    } else {
        console.log('No sessions')
        process.exit(0)
    }
})()
