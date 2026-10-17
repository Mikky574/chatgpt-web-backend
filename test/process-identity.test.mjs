import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
test('Windows stop ownership requires current project absolute entry and Node executable',{skip:process.platform!=='win32'},()=>{
 const helper=path.resolve('scripts/process-identity.ps1').replaceAll("'","''");
 const code=`. '${helper}'; $root='C:\\tools\\demo';
 if(!(Test-ProjectServiceCommand 'node.exe "C:\\tools\\demo\\server.mjs"' 'C:\\node\\node.exe' $root)){throw 'absolute match failed'}
 if(Test-ProjectServiceCommand 'node.exe server.mjs' 'C:\\node\\node.exe' $root){throw 'relative path accepted'}
 if(Test-ProjectServiceCommand 'node.exe "C:\\other\\server.mjs"' 'C:\\node\\node.exe' $root){throw 'other project accepted'}
 if(Test-ProjectServiceCommand 'chrome.exe "C:\\tools\\demo\\server.mjs"' 'C:\\chrome\\chrome.exe' $root){throw 'browser accepted'}
 `;
 const result=spawnSync('powershell.exe',['-NoProfile','-Command',code],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
