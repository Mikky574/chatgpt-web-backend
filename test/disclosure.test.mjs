import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePacket} from '../consult-controller.mjs';
test('relative structure and credential file purpose can be disclosed without values',()=>{
  assert.doesNotThrow(()=>validatePacket({task_id:'demo',goal:'review',project_structure:['src/auth/','tests/','config/<credential-file>'],file_roles:['凭据文件：运行时鉴权，不传内容']}));
});
test('reject common credential values, raw fields and absolute structure paths',()=>{
  for(const extra of [{observations:['apiKey=secret-value-123456']},{observations:['Bearer abcdefghijklmnop']},{observations:['-----BEGIN PRIVATE KEY-----']},{project_structure:['C:/Users/user/project']},{project_structure:['../private']},{source_code:'private source'}]){
    assert.throws(()=>validatePacket({task_id:'demo',goal:'review',...extra}));
  }
});
