import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePacket,renderControllerMessage} from '../consult-controller.mjs';
test('relative structure and credential file purpose can be disclosed without values',()=>{
  assert.doesNotThrow(()=>validatePacket({task_id:'demo',goal:'review',project_structure:['src/auth/','tests/','config/<credential-file>'],file_roles:['凭据文件：运行时鉴权，不传内容']}));
});
test('wire message is concise Markdown without local metadata or empty sections',()=>{
  const message=renderControllerMessage({task_id:'local-private-identity',goal:'确认首次失败后的等待语义。',constraints:['仅允许0～5整数。'],observations:[],questions:['给出最多5个验收例。'],project_structure:['src/retry/'],file_roles:['配置中的凭据文件仅用于鉴权，不传值。']});
  assert.ok(message.startsWith('确认首次失败后的等待语义。\n'));
  assert.ok(message.includes('## 约束\n\n- 仅允许0～5整数。'));
  assert.ok(message.includes('src/retry/'));
  assert.ok(!message.includes('task_id'));
  assert.ok(!message.includes('local-private-identity'));
  assert.ok(!message.includes('当前事实'));
  assert.ok(!message.includes('你是主控手'));
  assert.equal(renderControllerMessage({task_id:'other',goal:'确认首次失败后的等待语义。',constraints:['仅允许0～5整数。'],questions:['给出最多5个验收例。'],project_structure:['src/retry/'],file_roles:['配置中的凭据文件仅用于鉴权，不传值。']}),message);
});
test('Markdown renderer applies disclosure checks before returning a message',()=>{
  assert.throws(()=>renderControllerMessage({task_id:'demo',goal:'review',observations:['Bearer abcdefghijklmnop']}),/credential/);
});
test('reject common credential values, raw fields and absolute structure paths',()=>{
  for(const extra of [{observations:['apiKey=secret-value-123456']},{observations:['Bearer abcdefghijklmnop']},{observations:['-----BEGIN PRIVATE KEY-----']},{project_structure:['C:/Users/user/project']},{project_structure:['../private']},{source_code:'private source'}]){
    assert.throws(()=>validatePacket({task_id:'demo',goal:'review',...extra}));
  }
});
test('causal consultation separates evidence from hypotheses and retains decision context',()=>{
  const message=renderControllerMessage({task_id:'private-local-id',goal:'检查串答风险。',symptoms:['网页有回答，本地超时。'],expected_behavior:['仅读取本轮。'],evidence:['折叠按钮加入了正文。'],hypotheses:['可能导致严格匹配失败。'],options:['按DOM排除控件。'],unknowns:['虚拟化布局尚未验证。'],questions:['给出能区分原因的测试。']});
  assert.ok(message.includes('## 已验证证据\n\n- 折叠按钮加入了正文。'));
  assert.ok(message.includes('## 待验证假设\n\n- 可能导致严格匹配失败。'));
  assert.ok(message.includes('虚拟化布局尚未验证。'));
  assert.ok(!message.includes('private-local-id'));
  for(const field of ['symptoms','expected_behavior','evidence','hypotheses','options','unknowns']) {
    assert.throws(()=>renderControllerMessage({task_id:'demo',goal:'review',[field]:['Bearer abcdefghijklmnop']}),/credential/);
  }
});
