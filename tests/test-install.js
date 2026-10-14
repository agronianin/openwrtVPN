'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const project = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'openwrtvpn-install-'));
try {
  const code = path.join(work,'code');
  fs.mkdirSync(code);
  for (const name of ['defaults','router-reinstall-kit/files']) {
    fs.mkdirSync(path.dirname(path.join(code,name)),{recursive:true});
    fs.symlinkSync(path.join(project,name),path.join(code,name));
  }
  let script = fs.readFileSync(path.join(project,'install.sh'),'utf8');
  script = script.replace(/(?<![\w/])\/(etc|usr|opt|root|sys)\b/g,'${SANDBOX}/$1').replaceAll('"/$1"','"$SANDBOX/$1"');
  // Never execute the unmodified installer on the developer machine.
  fs.writeFileSync(path.join(code,'install.sh'),script);
  const bin = path.join(work,'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'uci'), `#!/usr/bin/env node
const fs=require('node:fs'); const file=process.env.SANDBOX+'/state.json';
const state=JSON.parse(fs.readFileSync(file)); const args=process.argv.slice(2).filter(x=>x!=='-q');
if(args[0]==='show') console.log("firewall.@zone[0].name='wan'");
else if(args[0]==='get') { if(!(args[1] in state)) process.exit(1); console.log(state[args[1]]); }
else if(args[0]==='set'||args[0]==='add_list') { const pos=args[1].indexOf('='); const key=args[1].slice(0,pos); const value=args[1].slice(pos+1); state[key]=args[0]==='set'?value:(state[key]||'')+' '+value; fs.writeFileSync(file,JSON.stringify(state)); }
`); fs.chmodSync(path.join(bin,'uci'),0o755);
  for (const name of ['ubus','opkg','apk','sysupgrade','sing-box']) {
    fs.writeFileSync(path.join(bin,name), `#!/bin/sh\necho '${name}' "$@" >> "$SANDBOX/commands"\n` + (name==='sing-box'?'[ "$1" != version ] || echo "sing-box version 1.14.3"\n':''));
    fs.chmodSync(path.join(bin,name),0o755);
  }
  for (const modem of ['0','1']) {
    const sandbox=path.join(work,'root-'+modem); fs.mkdirSync(sandbox);
    for (const dir of ['etc/init.d','etc/config','etc/crontabs']) fs.mkdirSync(path.join(sandbox,dir),{recursive:true});
    fs.writeFileSync(path.join(sandbox,'etc/shadow'),'root:$6$test:test::::::\n');
    for (const name of ['firewall','cron','modemmanager']) {
      const file=path.join(sandbox,'etc/init.d',name);
      fs.writeFileSync(file,'#!/bin/sh\necho service "$0" "$@" >> "$SANDBOX/commands"\n'); fs.chmodSync(file,0o755);
    }
    fs.writeFileSync(path.join(sandbox,'etc/init.d/sing-box'),'#!/bin/sh\n[ "$1" != status ]\n'); fs.chmodSync(path.join(sandbox,'etc/init.d/sing-box'),0o755);
    const original={'firewall.@zone[0].network':'wan wan6 existing-uplink','firewall.@zone[0].device':'existing-device','network.lan.ipaddr':'10.50.1.1'};
    fs.writeFileSync(path.join(sandbox,'state.json'),JSON.stringify(original));
    // procd scripts are copied but not executed by a non-OpenWrt host shell.
    script=fs.readFileSync(path.join(code,'install.sh'),'utf8').replace(/^.*\/etc\/init\.d\/(router-control-web|modem-t77w968-qmi|sing-box) (enable|disable|restart)$/gm,'true');
    fs.writeFileSync(path.join(code,'run.sh'),script);
    execFileSync('sh',[path.join(code,'run.sh')],{env:{...process.env,PATH:bin+':'+process.env.PATH,SANDBOX:sandbox,INSTALL_MODEM:modem}});
    const state=JSON.parse(fs.readFileSync(path.join(sandbox,'state.json')));
    assert.equal(state['network.lan.ipaddr'],original['network.lan.ipaddr']);
    assert.ok(state['firewall.@zone[0].network'].includes('existing-uplink'));
    assert.ok(state['firewall.@zone[0].device'].includes('tun0'));
    assert.equal(state['openwrtvpn.main.modem_enabled'],modem);
    assert.equal(fs.existsSync(path.join(sandbox,'usr/bin/modem-t77w968')),modem==='1');
    assert.ok(fs.existsSync(path.join(sandbox,'opt/router-control/www/vpn.js')));
    assert.equal(fs.readFileSync(path.join(sandbox,'etc/sing-box/config.json'),'utf8'),fs.readFileSync(path.join(project,'defaults/config.json'),'utf8'));
    assert.ok(!fs.existsSync(path.join(sandbox,'usr/bin/modem-qmi-connect')));
    assert.ok(!fs.readFileSync(path.join(sandbox,'etc/sing-box/subscriptions.d/black.txt'),'utf8').includes('withblancvpn'));
  }
  console.log('PASS: sandbox fresh installation with/without modem, clean defaults, preserved LAN/WAN; no host services executed');
} finally { fs.rmSync(work,{recursive:true,force:true}); }
