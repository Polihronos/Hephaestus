// This policy is intentionally deterministic. It checks evidence, timing and lexical
// similarity; it cannot establish that an image claim is true or translate paraphrases.
const STOP=new Set(('the a an and or to of in on for is are was be this that your you i it with from as at by my we our can should could will have has now please '+
 'и в на за с със от до е са това тази този като по ще може трябва ми аз ти не '+
 'el la los las un una de del en y o es son para por con que su se '+
 'le les une des du et est sont pour avec ce cette vous il '+
 'der die das ein eine und ist sind für mit zu von im den '+
 'и на в для с это как что при не').split(/\s+/));
export const NOTICE_TASK_MAX_AGE=2*60*60*1000;
export const NOTICE_COOLDOWN=90000;
const words=new Intl.Segmenter('und',{granularity:'word'});
export function normalizeNoticeText(value) {
 return String(value??'').normalize('NFKC').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu,' ').replace(/\s+/gu,' ').trim();
}
export function noticeTerms(value) {
 return [...new Set([...words.segment(normalizeNoticeText(value))].filter(part=>part.isWordLike).map(part=>part.segment).filter(t=>(t.length>2||t.length>=2&&/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(t))&&!STOP.has(t)))];
}
const grams=value=>{const s=normalizeNoticeText(value).replace(/\s/g,'');return new Set(Array.from({length:Math.max(0,s.length-2)},(_,i)=>s.slice(i,i+3)));};
function overlap(a,b){let n=0;for(const x of a)if(b.has(x))n++;return n;}
export function equivalentNotices(a,b) {
 const x=normalizeNoticeText(a),y=normalizeNoticeText(b);if(!x||!y)return false;if(x===y)return true;
 const identifiers=s=>new Set(s.match(/\b\p{L}[\p{L}\p{N}_]*\p{N}[\p{L}\p{N}_]*\b/gu)??[]),xi=identifiers(x),yi=identifiers(y);
 if(xi.size&&yi.size&&(xi.size!==yi.size||overlap(xi,yi)!==xi.size))return false;
 const at=new Set(noticeTerms(x)),bt=new Set(noticeTerms(y)),common=overlap(at,bt);
 if(common>=3&&common/Math.max(1,Math.min(at.size,bt.size))>=.8&&common/Math.max(at.size,bt.size)>=.55)return true;
 const ag=grams(x),bg=grams(y);return ag.size>12&&bg.size>12&&2*overlap(ag,bg)/(ag.size+bg.size)>=.76;
}
const field=(notice,key)=>String(notice[key]??'').trim();
export function evaluateNotice({notice,context,recentNotices=[],feedback=[],enabled=true,snoozeUntil=0,lastNoticeAt=0,observation,now=Date.now(),background=true}) {
 const suppress=reason=>({status:'suppressed',reason,retry:false});
 if(!enabled)return suppress('paused');
 if(snoozeUntil>now)return suppress('snoozed');
 if(lastNoticeAt&&now-lastNoticeAt<NOTICE_COOLDOWN)return suppress('cooldown');
 const text=field(notice,'text');if(text.length<12)return suppress('too-vague');
 if(recentNotices.some(m=>now-m.at<24*60*60*1000&&equivalentNotices(text,m.text)))return suppress('repeated-meaning');
 const subject=field(notice,'subject');
 const latestFeedback=feedback.filter(f=>((subject&&f.subject&&equivalentNotices(subject,f.subject))||equivalentNotices(text,f.text))).sort((a,b)=>b.at-a.at)[0];
 if(latestFeedback?.value==='dismiss'&&now-latestFeedback.at<30*24*60*60*1000)return suppress('dismissed-subject');
 // Legacy foreground callers can still request a plain-text notice explicitly.
 if(!background&&!notice.kind&&!notice.rationale&&!notice.benefit)return{status:'shown'};
 if(!['problem','opportunity'].includes(notice.kind))return suppress('status-only');
 if(['rationale','benefit','action','task','evidence','subject'].some(key=>field(notice,key).length<8))return suppress('missing-actionable-evidence');
 const user=context?.lastUserMessage,currentUser=user&&Number.isFinite(user.at)&&now-user.at<=NOTICE_TASK_MAX_AGE;
 if(!observation||!Number.isFinite(observation.capturedAt)||now-observation.capturedAt>45000)return suppress('stale-observation');
 if(notice.observationId&&notice.observationId!==observation.id)return suppress('stale-observation');
 const taskTerms=new Set(noticeTerms(currentUser?user.text:notice.task)),claimTerms=new Set(noticeTerms(notice.task+' '+notice.rationale));
 // Exact identifiers, Unicode words and character n-grams also work outside English.
 if(notice.taskSource==='conversation'&&!currentUser)return suppress('no-current-task');
 if(currentUser&&notice.taskSource!=='screen'&&!overlap(taskTerms,claimTerms)&&!equivalentNotices(user.text,notice.task))return suppress('unrelated-task');
 if(notice.taskSource==='screen'||!currentUser){const inferred=new Set(noticeTerms(notice.task)),evidence=new Set(noticeTerms(notice.evidence));if(overlap(inferred,evidence)<2)return suppress('ungrounded-screen-task');}
 if(noticeTerms(notice.action).length<3||noticeTerms(notice.benefit).length<3||noticeTerms(notice.evidence).length<3)return suppress('too-vague');
 if(overlap(new Set(noticeTerms(text)),new Set(noticeTerms(notice.action)))<2)return suppress('missing-visible-action');
 // Repeating the observation as its own benefit does not explain a useful intervention.
 if(equivalentNotices(text,notice.benefit)||equivalentNotices(notice.evidence,notice.benefit)||equivalentNotices(notice.action,notice.evidence))return suppress('status-only');
 return{status:'shown'};
}
