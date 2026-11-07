import {marked} from './vendor/marked.js';
import DOMPurify from './vendor/purify.js';
export function renderMarkdown(element,text){
 element.classList.add('markdown');
 element.innerHTML=DOMPurify.sanitize(marked.parse(String(text??''),{gfm:true,breaks:true}),{ALLOWED_TAGS:['p','br','strong','em','del','code','pre','blockquote','ul','ol','li','table','thead','tbody','tr','th','td','h1','h2','h3','h4','h5','h6','hr','a'],ALLOWED_ATTR:['href','title','colspan','rowspan','align'],ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false,FORBID_TAGS:['img','video','audio','iframe','style','input','form','button'],FORBID_ATTR:['style','id']});
 for(const a of element.querySelectorAll('a')){a.rel='noopener noreferrer';a.addEventListener('click',e=>{e.preventDefault();window.companion?.request('open-link',{url:a.href});});}
}
