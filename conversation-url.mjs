export function conversationUrl(value){
 try{const u=new URL(value);if(u.origin!=='https://chatgpt.com'||u.search||u.hash)return null;
 const normal=u.pathname.match(/^\/c\/([A-Za-z0-9-]+)$/);if(normal)return u.origin+'/c/'+normal[1];
 const project=u.pathname.match(/^\/g\/(g-p-[a-f0-9]{32})(?:-[A-Za-z0-9-]+)?\/c\/([A-Za-z0-9-]+)$/i);return project?`${u.origin}/g/${project[1]}/c/${project[2]}`:null;
 }catch{return null;}
}
export function projectUrl(value){
 try{const u=new URL(value);if(u.origin!=='https://chatgpt.com'||u.search||u.hash)return null;const m=u.pathname.match(/^\/g\/(g-p-[a-f0-9]{32})(?:-[A-Za-z0-9-]+)?\/project$/i);return m?`${u.origin}/g/${m[1]}/project`:null;}catch{return null;}
}
export function projectForConversation(value){const url=conversationUrl(value);const m=url?.match(/^https:\/\/chatgpt\.com\/g\/(g-p-[a-f0-9]{32})\/c\//i);return m?`https://chatgpt.com/g/${m[1]}/project`:null;}
