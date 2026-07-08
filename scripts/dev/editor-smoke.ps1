<#
.SYNOPSIS
  Editor regression smoke test for the Windows plain-textarea editor (SoloMD).

.DESCRIPTION
  Drives the running `tauri dev` SoloMD instance through the dev-bridge
  (HTTP /eval) and exercises the editor end to end: new-doc focus, typing,
  selection replace, Enter, Tab indent, undo/redo, task-checkbox toggle,
  find/replace, word-wrap and spellcheck attributes. Each test reloads the app
  for a clean document, seeds content, performs an action, and asserts the
  result. Prints a pass/fail table.

  Requires: a running `tauri dev` instance (dev-bridge writes its port/token to
  %APPDATA%\app.solomd\dev-bridge.{port,token}). viewMode is forced to liveEdit.

.EXAMPLE
  pwsh -File scripts/dev/editor-smoke.ps1
#>

$ErrorActionPreference = 'Stop'
$port  = (Get-Content "$env:APPDATA\app.solomd\dev-bridge.port").Trim()
$token = (Get-Content "$env:APPDATA\app.solomd\dev-bridge.token").Trim()
Write-Host "dev-bridge: 127.0.0.1:$port" -ForegroundColor Cyan

function Invoke-Eval([string]$js, [int]$timeoutMs = 15000) {
  $body = @{ script = $js; timeout_ms = $timeoutMs } | ConvertTo-Json -Depth 8
  $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/eval" -Method Post `
      -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' `
      -Body $body -NoProxy -TimeoutSec 30
  if (-not $r.ok) { throw "eval error: $($r.error)" }
  return $r.value
}

# Shared JS helpers injected before every test body.
$prelude = @'
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const setV=(el,v)=>{const p=Object.getPrototypeOf(el);Object.getOwnPropertyDescriptor(p,'value').set.call(el,v);};
const A=()=>document.querySelector('.plain-block--active textarea');
const blocks=()=>[...document.querySelectorAll('.plain-block')];
const activeIdx=()=>blocks().findIndex(b=>b.classList.contains('plain-block--active'));
async function waitEditor(){ for(let i=0;i<30 && !document.querySelector('.plain-block textarea, .plain-editor');i++) await sleep(150); }
async function seed(doc){ let ta=A()||document.querySelector('.plain-block textarea'); ta.focus(); setV(ta,doc); ta.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'})); await sleep(250); }
async function imeCommit(el,s){ el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})); const a=el.selectionStart,b=el.selectionEnd; setV(el, el.value.slice(0,a)+s+el.value.slice(b)); el.setSelectionRange(a+s.length,a+s.length); el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:s,isComposing:true})); el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:s})); await sleep(140); }
async function typeChar(ch){ let e=A(); const s=e.selectionStart; setV(e, e.value.slice(0,s)+ch+e.value.slice(s)); e.setSelectionRange(s+1,s+1); e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:ch})); await sleep(650); }
async function pressEnter(el){ const a=el.selectionStart; setV(el, el.value.slice(0,a)+'\n'+el.value.slice(a)); el.setSelectionRange(a+1,a+1); el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertLineBreak'})); await sleep(200); }
const key=(el,k,opt={})=>el.dispatchEvent(new KeyboardEvent('keydown',Object.assign({key:k,bubbles:true},opt)));
'@

# Each test: name, seed doc, and a JS body returning { pass: bool, detail: any }.
$tests = @(
  @{ n='new-doc auto-focus'; seed=$null; body=@'
await waitEditor(); const ta=A();
return { pass: !!ta && document.activeElement===ta, detail:{ active: document.activeElement?.tagName, hasTextarea:!!ta } };
'@ }
  @{ n='new-doc type'; seed=$null; body=@'
await waitEditor(); let ta=A(); ta.focus(); setV(ta,'你好'); ta.setSelectionRange(2,2); ta.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'好'})); await sleep(150);
ta=A(); return { pass: ta && ta.value==='你好', detail:{ val: ta?.value } };
'@ }
  @{ n='paragraph: type at start'; seed='# H\n\n普通段落内容\n\n末段'; body=@'
let i=blocks().findIndex(b=>b.querySelector('.plain-block__render')?.textContent.includes('普通段落')); blocks()[i].click(); await sleep(150);
let el=A(); el.setSelectionRange(0,0); await imeCommit(el,'你好'); el=A();
return { pass: el&&el.value==='你好普通段落内容'&&el.selectionStart===2&&activeIdx()===i, detail:{val:el?.value,caret:el?.selectionStart} };
'@ }
  @{ n='paragraph: type at end (no newline)'; seed='# H\n\n普通段落内容\n\n末段'; body=@'
let i=blocks().findIndex(b=>b.querySelector('.plain-block__render')?.textContent.includes('普通段落')); blocks()[i].click(); await sleep(150);
let el=A(); el.setSelectionRange(el.value.length,el.value.length); await imeCommit(el,'好'); el=A();
return { pass: el&&el.value==='普通段落内容好'&&!el.value.includes('\n'), detail:{val:JSON.stringify(el?.value)} };
'@ }
  @{ n='paragraph: selection replace'; seed='# H\n\n普通段落内容\n\n末段'; body=@'
let i=blocks().findIndex(b=>b.querySelector('.plain-block__render')?.textContent.includes('普通段落')); blocks()[i].click(); await sleep(150);
let el=A(); el.setSelectionRange(0,2); await imeCommit(el,'测试'); el=A();
return { pass: el&&el.value==='测试段落内容'&&activeIdx()===i, detail:{val:el?.value} };
'@ }
  @{ n='whole-line select replace (no preview flip)'; seed='# H\n\n整段文字\n\n末段'; body=@'
let i=blocks().findIndex(b=>b.querySelector('.plain-block__render')?.textContent.includes('整段文字')); blocks()[i].click(); await sleep(150);
let el=A(); el.setSelectionRange(0,el.value.length); await imeCommit(el,'你好'); el=A();
return { pass: !!el&&el.value==='你好'&&activeIdx()===i, detail:{val:el?.value,stillEditing:!!el} };
'@ }
  @{ n='list: type before "-" marker'; seed='- 列表项一\n- 列表项二\n- 列表项三'; body=@'
let el=A(); el.setSelectionRange(0,0); setV(el,'x'+el.value); el.setSelectionRange(1,1); el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'x'})); await sleep(150); el=A();
return { pass: !!el&&el.selectionStart===1&&el.value==='x- 列表项一', detail:{caret:el?.selectionStart,val:el?.value} };
'@ }
  @{ n='multiline block: type at 2nd line start'; seed='第一行\n第二行\n第三行'; body=@'
let el=A(); const p2=el.value.indexOf('\n')+1; el.setSelectionRange(p2,p2); await imeCommit(el,'你好'); el=A();
return { pass: !!el&&el.value==='第一行\n你好第二行\n第三行'&&el.selectionStart===p2+2, detail:{val:JSON.stringify(el?.value)} };
'@ }
  @{ n='Enter at mid paragraph row-end'; seed='第一段\n\n第二段\n\n第三段'; body=@'
blocks()[0].click(); await sleep(150); let el=A(); el.setSelectionRange(el.value.length,el.value.length); const i0=activeIdx();
await pressEnter(el); const cur=A();
return { pass: !!cur&&activeIdx()===i0+1&&cur.selectionStart===0&&document.activeElement===cur, detail:{idx:activeIdx(),caret:cur?.selectionStart,focused:document.activeElement===cur} };
'@ }
  @{ n='Enter at last block end (new line + focus)'; seed='第一段\n\n最后一段'; body=@'
let i=blocks().length-1; blocks()[i].click(); await sleep(150); let el=A(); el.setSelectionRange(el.value.length,el.value.length); const b0=blocks().length;
await pressEnter(el); const cur=A();
return { pass: !!cur&&cur.value===''&&cur.selectionStart===0&&document.activeElement===cur&&blocks().length===b0+1, detail:{val:JSON.stringify(cur?.value),focused:document.activeElement===cur,blocks:blocks().length} };
'@ }
  @{ n='Tab indent (caret after indent)'; seed='测试段落'; body=@'
let el=A(); el.focus(); el.setSelectionRange(0,0); key(el,'Tab'); await sleep(200); el=A();
return { pass: el&&el.value==='  测试段落'&&el.selectionStart===2, detail:{val:JSON.stringify(el?.value),caret:el?.selectionStart} };
'@ }
  @{ n='undo / redo'; seed='测试'; body=@'
let el=A(); el.setSelectionRange(el.value.length,el.value.length); await typeChar('甲'); await typeChar('乙');
const typed=A().value; key(A(),'z',{ctrlKey:true}); await sleep(300); const u1=A()?.value; key(A(),'z',{ctrlKey:true,shiftKey:true}); await sleep(300); const r1=A()?.value;
return { pass: typed==='测试甲乙'&&u1==='测试甲'&&r1==='测试甲乙', detail:{typed,u1,r1} };
'@ }
  @{ n='task checkbox toggle'; seed='# T\n\n- [ ] 任务一\n- [x] 任务二\n\n末尾段落'; body=@'
const ti=blocks().findIndex(b=>b.querySelector('.plain-block__render')?.textContent.includes('任务一'));
const box=blocks()[ti].querySelector('input.task-list-item-checkbox'); const disabled=box.disabled;
box.dispatchEvent(new MouseEvent('click',{bubbles:true})); await sleep(250);
const t2=blocks().findIndex(b=>b.querySelector('.plain-block__render')?.textContent.includes('任务一')); blocks()[t2].click(); await sleep(150);
const src=A()?.value;
return { pass: !disabled && /- \[x\] 任务一/.test(src||''), detail:{disabled, src:JSON.stringify(src)} };
'@ }
  @{ n='find: count + next selects'; seed='苹果 香蕉 苹果\n\n橙子 苹果'; body=@'
key(A(),'f',{ctrlKey:true}); await sleep(250); const open=!!document.querySelector('.plain-find');
const fi=document.querySelector('.plain-find__input'); setV(fi,'苹果'); fi.dispatchEvent(new Event('input',{bubbles:true})); await sleep(200);
const count=document.querySelector('.plain-find__count')?.textContent;
[...document.querySelectorAll('.plain-find__btn')][1].dispatchEvent(new MouseEvent('click',{bubbles:true})); await sleep(200);
const e=A(); const sel=e?e.value.slice(e.selectionStart,e.selectionEnd):'';
return { pass: open&&count==='1/3'&&sel==='苹果', detail:{open,count,sel} };
'@ }
  @{ n='replace all'; seed='苹果 香蕉 苹果\n\n橙子 苹果'; body=@'
key(A(),'f',{ctrlKey:true}); await sleep(200);
const fi=document.querySelector('.plain-find__input'); setV(fi,'苹果'); fi.dispatchEvent(new Event('input',{bubbles:true})); await sleep(150);
const ri=document.querySelectorAll('.plain-find__input')[1]; setV(ri,'梨'); ri.dispatchEvent(new Event('input',{bubbles:true})); await sleep(100);
[...document.querySelectorAll('.plain-find__btn')].find(b=>b.textContent.trim()==='All').dispatchEvent(new MouseEvent('click',{bubbles:true})); await sleep(300);
const t=[]; const bs=blocks(); for(let i=0;i<bs.length;i++){ bs[i].click(); await sleep(120); t.push(A()?.value||''); }
const doc=t.join('\n\n'); return { pass: !doc.includes('苹果')&&(doc.match(/梨/g)||[]).length===3, detail:{doc:JSON.stringify(doc)} };
'@ }
  @{ n='word-wrap follows setting'; seed='这是一段很长很长的文字用来测试自动换行是否生效'; body=@'
const el=A(); const cs=getComputedStyle(el);
return { pass: el.getAttribute('wrap')==='soft'&&cs.whiteSpace==='pre-wrap', detail:{wrap:el.getAttribute('wrap'),ws:cs.whiteSpace} };
'@ }
  @{ n='spellcheck enabled'; seed='teh recieve'; body=@'
const el=A(); return { pass: el.getAttribute('spellcheck')==='true', detail:{spellcheck:el.getAttribute('spellcheck')} };
'@ }
  @{ n='smart Enter: continue bullet list'; seed='- 项一'; body=@'
let el=A(); el.setSelectionRange(el.value.length,el.value.length); key(el,'Enter'); await sleep(200); el=A();
return { pass: el.value==='- 项一\n- '&&el.selectionStart===el.value.length, detail:{val:JSON.stringify(el.value),caret:el.selectionStart} };
'@ }
  @{ n='smart Enter: end list on empty item'; seed='- 项一'; body=@'
let el=A(); el.setSelectionRange(el.value.length,el.value.length); key(el,'Enter'); await sleep(200); el=A();
key(el,'Enter'); await sleep(250);
const cur=A(); const endedEmpty = !!cur && cur.value==='';
const txt=blocks().map(b=>(b.querySelector('.plain-block__render')?.textContent||b.querySelector('textarea')?.value||''));
return { pass: endedEmpty && txt.some(t=>t.includes('项一')) && !txt.some(t=>/项一[\s\S]*-\s*$/.test(t)), detail:{endedEmpty,txt} };
'@ }
  @{ n='smart Enter: ordered list increments'; seed='1. 甲'; body=@'
let el=A(); el.setSelectionRange(el.value.length,el.value.length); key(el,'Enter'); await sleep(200); el=A();
return { pass: el.value==='1. 甲\n2. ', detail:{val:JSON.stringify(el.value)} };
'@ }
  @{ n='slash command: popup + filter + insert'; seed=$null; body=@'
await waitEditor(); let el=A(); el.focus();
setV(el,'/'); el.setSelectionRange(1,1); el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'/'})); await sleep(200);
const opened=!!document.querySelector('.plain-ac'); const n1=document.querySelectorAll('.plain-ac__item').length;
setV(el,'/todo'); el.setSelectionRange(5,5); el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'o'})); await sleep(200);
const labels=[...document.querySelectorAll('.plain-ac__item .plain-ac__label')].map(x=>x.textContent);
el=A(); key(el,'Enter'); await sleep(250); el=A();
return { pass: opened && n1>0 && labels.length===1 && el.value==='- [ ] ' && !document.querySelector('.plain-ac'), detail:{opened,n1,labels,val:JSON.stringify(el.value)} };
'@ }
)

# Force liveEdit once.
try { Invoke-Eval "const s=JSON.parse(localStorage.getItem('solomd.settings.v1')||'{}'); s.viewMode='liveEdit'; s.wordWrap=true; s.spellCheck=true; localStorage.setItem('solomd.settings.v1',JSON.stringify(s)); return 1;" 5000 | Out-Null } catch {}

$results = @()
foreach ($t in $tests) {
  # Reload to a clean Untitled doc for isolation.
  try { Invoke-Eval "for(const k of Object.keys(localStorage)){if(k.startsWith('solomd.tabs'))localStorage.removeItem(k);} location.reload(); return 1;" 2000 | Out-Null } catch {}
  Start-Sleep -Seconds 3
  $seedJs = if ($null -ne $t.seed) { "await waitEditor(); await seed('" + $t.seed + "');" } else { "" }
  $full = $prelude + "`ntry{ $seedJs`n" + $t.body + "`n}catch(e){ return { pass:false, detail:{error:String(e)} }; }"
  try {
    $v = Invoke-Eval $full 18000
    $results += [pscustomobject]@{ Test=$t.n; Pass=[bool]$v.pass; Detail=($v.detail | ConvertTo-Json -Compress -Depth 6) }
  } catch {
    $results += [pscustomobject]@{ Test=$t.n; Pass=$false; Detail="HARNESS ERROR: $($_.Exception.Message)" }
  }
}

Write-Host ""
$results | ForEach-Object {
  $mark = if ($_.Pass) { '[PASS]' } else { '[FAIL]' }
  $color = if ($_.Pass) { 'Green' } else { 'Red' }
  Write-Host ("{0} {1}" -f $mark, $_.Test) -ForegroundColor $color
  if (-not $_.Pass) { Write-Host ("        -> {0}" -f $_.Detail) -ForegroundColor DarkGray }
}
$passed = ($results | Where-Object Pass).Count
$summaryColor = if ($passed -eq $results.Count) { 'Green' } else { 'Yellow' }
Write-Host ""
Write-Host ("PASSED {0}/{1}" -f $passed, $results.Count) -ForegroundColor $summaryColor
if ($passed -ne $results.Count) { exit 1 }
