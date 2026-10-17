import {projectUrl} from './conversation-url.mjs';
export async function listProjects(bridge){
 const browser=await bridge.connect(),rows=[];
 if(browser.contexts().length!==1)throw Error('多个登录上下文，无法确定项目所属账号');
 for(const page of browser.contexts()[0].pages())if(page.url().startsWith('https://chatgpt.com/'))rows.push(...await page.locator('[data-app-action-sidebar-project-id]').evaluateAll(es=>es.map(e=>({id:e.getAttribute('data-app-action-sidebar-project-id'),name:e.getAttribute('data-app-action-sidebar-project-label')}))));
 return [...new Map(rows.filter(p=>/^g-p-[a-f0-9]{32}$/i.test(p.id)&&p.name).map(p=>[p.id,{...p,url:`https://chatgpt.com/g/${p.id}/project`}])).values()];
}
export async function createProject(bridge,name){
 if(typeof name!=='string'||!name.trim()||name.length>80)throw Error('项目名称需为1..80字符');name=name.trim();
 const existing=(await listProjects(bridge)).filter(p=>p.name===name);if(existing.length===1)return {...existing[0],reused:true};if(existing.length>1)throw Error('项目重名，请按明确项目URL选择');
 const page=await bridge.page({conversation_mode:'new'});
 if(await page.locator('[contenteditable=true]:visible').evaluateAll(es=>es.some(e=>e.innerText.trim())))throw Error('页面有草稿，停止创建项目');
 const add=page.getByRole('button',{name:/^(添加新项目|新建项目|New project|Add new project)$/i}).filter({visible:true});if(await add.count()!==1)throw Error('找不到唯一的官网创建项目控件');
 await add.press('Enter',{timeout:5000});const dialog=page.locator('[role=dialog]:visible');await dialog.waitFor({timeout:5000});
 const input=dialog.locator('input[type=text]');if(await input.count()!==1)throw Error('项目名称输入框不唯一');await input.fill(name);
 const create=dialog.getByRole('button',{name:/^(创建项目|Create project)$/i});if(await create.count()!==1)throw Error('官网创建项目按钮不唯一');
 await create.click({timeout:5000});await dialog.waitFor({state:'hidden',timeout:15000});
 await page.waitForURL(url=>!!projectUrl(url.toString()),{timeout:15000});
 const url=projectUrl(page.url());return {id:url.split('/')[4],name,url,reused:false};
}
