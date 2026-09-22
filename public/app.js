const socket = io();
let state = null;
let localSelected = []; // [{tile, wallIndex}] - physical tile instances, not just tile types
let lastPhase = null;
let setupTimerHandle = null;
let setupPreview = [];
let resultTimerHandle = null;
let localKaijiTiles = [];
let setupTimerHandle2 = null;
let turnTimerHandle = null;
let doraRevealHandle = null;
let ronRevealHandle = null;

const $ = id => document.getElementById(id);
const screens = [...document.querySelectorAll('.screen')];
function show(screenId){screens.forEach(s=>s.classList.toggle('active',s.id===screenId)); window.scrollTo(0,0)}
function money(n){return Number(n||0).toLocaleString('ko-KR')+'원'}
const TILE_LABELS=['1萬','2萬','3萬','4萬','5萬','6萬','7萬','8萬','9萬','1筒','2筒','3筒','4筒','5筒','6筒','7筒','8筒','9筒','1索','2索','3索','4索','5索','6索','7索','8索','9索','東','南','西','北','白','發','中'];
function tileLabel(t){return TILE_LABELS[t]||''}
function doraFromIndicatorLocal(ind){if(ind<27)return ind%9===8?ind-8:ind+1;if(ind<=30)return ind===30?27:ind+1;if(ind===31)return 32;if(ind===32)return 33;return 31;}
const YAKU_KO={
  '立直':'리치','一発':'일발','河底撈魚':'하저로어','断么九':'탕야오','平和':'핑후','一盃口':'이페코','二盃口':'량페코',
  '混一色':'혼일색','清一色':'청일색','純全帯么九':'준찬타','混全帯么九':'찬타','混老頭':'혼노두','対々和':'또이또이',
  '一気通貫':'일기통관','三色同順':'삼색동순','三色同刻':'삼색동각','小三元':'소삼원','三暗刻':'산안커','七対子':'치또이츠',
  '国士無双':'국사무쌍','大四喜':'대사희','小四喜':'소사희','四暗刻':'스안커','九蓮宝燈':'구련보등','緑一色':'녹일색',
  '清老頭':'청노두','字一色':'자일색','大三元':'대삼원','ドラ':'도라','裏ドラ':'우라도라','カイジ特수능력':'카이지 특수능력'
};
function yakuKo(name){
  if(name.startsWith('役牌 ')){
    const tile=name.slice(3);
    if(['白','發','中'].includes(tile)) return `삼원패(${tile.replace('白','백').replace('發','발').replace('中','중')})`;
    return `자풍패(${tile.replace('東','동').replace('南','남').replace('西','서').replace('北','북')})`;
  }
  return YAKU_KO[name]||name;
}
function classKo(label){
  if(label==='満貫')return '만관';
  if(label==='跳満')return '하네만';
  if(label==='倍満')return '배만';
  if(label==='三倍満')return '삼배만';
  if(label==='役満')return '역만';
  if(label==='2倍役満')return '더블 역만';
  if(label==='数え役満')return '헤아림 역만';
  if(/倍役満$/.test(label))return label.replace('倍役満','배 역만');
  return label;
}
function yakuRarity(han){if(han>=26)return 'yaku-tier-5';if(han>=13)return 'yaku-tier-5';if(han>=6)return 'yaku-tier-4';if(han>=3)return 'yaku-tier-3';if(han>=2)return 'yaku-tier-2';return 'yaku-tier-1';}
function rarityClass(label){
  if(label==='역만'||label==='더블 역만'||label==='헤아림 역만')return 'yaku-tier-5';
  if(label==='삼배만')return 'yaku-tier-4';
  if(label==='배만')return 'yaku-tier-3';
  if(label==='하네만')return 'yaku-tier-2';
  return 'yaku-tier-1';
}
function previewYakuText(item){
  const names=(item.yaku||[]).map(y=>`${yakuKo(y[0])} ${y[1]}판`);
  return names.length?names.join(' · '):'역 없음';
}
function tileImage(t){
  const img=document.createElement('img');
  img.alt=tileLabel(t);
  img.draggable=false;
  const candidates=[`.png`,`.jpg`,`.jpeg`,`.webp`,`.gif`];
  let i=0;
  const tryNext=()=>{
    if(i>=candidates.length){img.removeAttribute('src');img.classList.add('tile-image-failed');return;}
    img.src=`/assets/tiles/${t}${candidates[i++]}`;
  };
  img.onerror=tryNext;
  tryNext();
  return img;
}
function sortTiles(items){ return [...(items||[])].sort((a,b)=>a-b); }
function sortTileInstances(items){
  return [...(items||[])].sort((a,b)=>a.tile-b.tile || a.wallIndex-b.wallIndex);
}
function renderTile(t, cls='tile'){
  const d=document.createElement('div');
  d.className=cls;
  d.dataset.tile=t;
  d.title=tileLabel(t);
  d.appendChild(tileImage(t));
  return d;
}
function setTileContent(container,t,cls=''){
  container.innerHTML='';
  const el=renderTile(t,cls);
  container.appendChild(el);
  return el;
}
function toast(msg){const x=$('toast'); x.textContent=msg; x.classList.add('show'); setTimeout(()=>x.classList.remove('show'),2200)}

$('createBtn').onclick=()=>{const mode=document.querySelector('input[name=gameMode]:checked')?.value||'ORIGINAL';socket.emit('create_room',{nickname:$('nickname').value.trim()||'Player 1',stake:Number($('stake').value)||1000000,gameMode:mode})};
document.querySelectorAll('input[name=gameMode]').forEach(r=>r.addEventListener('change',()=>document.querySelectorAll('.mode-card').forEach(c=>c.classList.toggle('selected',c.querySelector('input')?.checked))));
$('joinBtn').onclick=()=>socket.emit('join_room',{nickname:$('nickname').value.trim()||'Player 2',code:$('joinCode').value.trim()});
$('copyRoomBtn').onclick=async()=>{await navigator.clipboard?.writeText($('bigRoomCode').textContent); toast('방 코드를 복사했습니다.')};
document.querySelectorAll('.character-option').forEach(btn=>btn.addEventListener('click',()=>{
  const ch=btn.dataset.character;
  if(state?.characterChoices?.EAST===ch || state?.characterChoices?.WEST===ch){toast('상대가 이미 선택한 캐릭터입니다.');return;}
  socket.emit('select_character',{character:ch});
}));

$('confirmHandBtn').onclick=()=>{
  if(state?.me?.setupConfirmed && !state?.opponent?.setupConfirmed){socket.emit('unlock_setup');return;}
  if(localSelected.length!==13){toast('13장을 선택하세요.');return}
  const ch=state?.me?.character;
  if(ch==='KAIJI' && localKaijiTiles.length!==2){toast('카이지 특수 론패를 2장 선택하세요.');return}
  if(ch==='AKAGI' && !state?.me?.akagiSuit){toast('절일문 수패를 선택하세요.');return}
  socket.emit('confirm_hand',{tiles:localSelected.map(x=>x.tile)});
};
$('ronBtn').onclick=()=>socket.emit('declare_ron');
$('passRonBtn').onclick=()=>socket.emit('pass_ron');
$('nextRoundBtn').onclick=()=>socket.emit('next_round');
$('restartGameBtn').onclick=()=>socket.emit('restart_game');
$('cancelAllSetupBtn').onclick=()=>{ if(state?.me?.setupConfirmed)return toast('이미 확정된 패는 상대가 확정하기 전까지 위 버튼으로 잠금을 풀 수 있습니다.'); localSelected=[]; document.querySelectorAll('#privateWall .tile.selected').forEach(el=>el.classList.remove('selected')); renderSelected(); renderAbilityPanel(state); socket.emit('preview_setup',{tiles:[]}); };

function renderLobby(s){
  $('roomCodeLobby').textContent=s.code; $('bigRoomCode').textContent=s.code;
  $('eastName').textContent=s.me?.seat==='EAST'?s.me?.nickname:(s.opponent?.seat==='EAST'?s.opponent?.nickname:'-');
  $('westName').textContent=s.me?.seat==='WEST'?s.me?.nickname:(s.opponent?.seat==='WEST'?s.opponent?.nickname:'-');
  $('westStatus').textContent=s.opponent?'READY':'WAITING';
}
function renderCharacterDraw(s){
  show('characterDraw');
  $('characterDrawRoom').textContent='ROOM '+s.code;
  const d=s.characterDraw||{};
  const myChoice=d.choices?.[s.me?.seat] ?? null;
  const revealed=!!d.revealed;
  const grid=$('characterDrawGrid');
  grid.innerHTML='';
  for(let i=0;i<9;i++){
    const b=document.createElement('button');
    b.className='character-draw-card-back'+(myChoice===i?' picked':'');
    b.innerHTML=`<span>?</span><small>미공개</small>`;
    b.disabled=revealed||myChoice!=null;
    b.onclick=()=>socket.emit('select_character_draw',{index:i});
    grid.appendChild(b);
  }
  const status=$('characterDrawStatus');
  const reveal=$('characterDrawReveal');
  if(!revealed){
    reveal.innerHTML='';
    status.textContent=myChoice!=null?'내 선택 완료 · 상대의 선택을 기다리는 중':'원하는 위치의 패를 골라주세요.';
    return;
  }
  const vals=d.values||[];
  const ev=d.choices?.EAST!=null?vals[d.choices.EAST]:null;
  const wv=d.choices?.WEST!=null?vals[d.choices.WEST]:null;
  const tile=(v,seat)=>v==null?'':`<div class="draw-result-player"><b>${seat==='EAST'?'東':'西'}</b><span class="draw-big-tile">${tileImageMarkup(v)}</span><strong>${v+1}만</strong></div>`;
  reveal.innerHTML=`<div class="draw-clash-title">운명의 패 공개!</div><div class="draw-result-row">${tile(ev,'EAST')}<div class="draw-vs">VS</div>${tile(wv,'WEST')}</div>${ev===wv?'<div class="draw-tie">동패! 다시 뽑습니다.</div>':`<div class="draw-winner">${d.picker===s.me?.seat?'내가':'상대가'} 캐릭터 선택권 획득 · ${d.picker==='EAST'?'東':'西'}가 먼저 선택</div>`}`;
  status.textContent=ev===wv?'잠시 후 다시 패를 고릅니다.':'공개 결과를 확인하세요.';
}

function renderCharacter(s){
  show('character');
  $('characterRoom').textContent='ROOM '+s.code;
  const choices=s.characterChoices||{};
  const mine=s.me?.character;
  const picker=s.characterPicker;
  document.querySelectorAll('.character-option').forEach(btn=>{
    const ch=btn.dataset.character;
    const taken=choices.EAST===ch||choices.WEST===ch;
    const myTurn=!mine && picker===s.me?.seat;
    btn.classList.toggle('selected',mine===ch);
    btn.classList.toggle('taken',taken&&mine!==ch);
    btn.disabled=!!mine || !myTurn || (taken&&mine!==ch);
  });
  const status=$('characterStatus');
  const instruction=$('characterPickInstruction');
  if(mine) status.textContent=`내 선택: ${s.me.characterName} · 상대의 선택을 기다리는 중`;
  else if(picker===s.me?.seat) status.textContent='당신이 먼저 캐릭터를 선택합니다.';
  else status.textContent=`상대가 먼저 캐릭터를 선택합니다. ${s.opponent?.nickname||'상대'}의 선택을 기다리는 중`;
  if(instruction) instruction.textContent=picker===s.me?.seat?'당신에게 캐릭터 선택권이 있습니다. 원하는 캐릭터를 먼저 선택하세요.':'상대에게 캐릭터 선택권이 있습니다. 상대의 선택을 기다리세요.';
}

function localCurrentWaits(){
  const hand=localSelected.map(x=>x.tile);
  if(hand.length!==13)return [];
  const counts=Array(34).fill(0); hand.forEach(t=>counts[t]++);
  const waits=[];
  for(let t=0;t<34;t++){if(counts[t]>=4)continue;counts[t]++;if(isAgariLocal(counts))waits.push(t);counts[t]--;}
  return waits;
}

function renderAbilityPanel(s){
  const box=$('characterAbility');
  if(!box)return;
  if(s.gameMode!=='CHARACTER' || !s.me?.character){box.classList.add('hidden');return;}
  box.classList.remove('hidden');
  const ch=s.me.character;
  if(ch==='KAIJI'){
    if(!localKaijiTiles.length && s.me.specialRonTiles?.length) localKaijiTiles=[...s.me.specialRonTiles];
    const waits=new Set(localCurrentWaits());
    const ready=localKaijiTiles.length===2 && localKaijiTiles.every(t=>!waits.has(t));
    box.innerHTML=`<div class="ability-title">${s.me.characterName} · 특수 론</div><p>현재 대기패를 제외한 패 중 2장을 골라, 상대가 그 패를 버리면 반드시 특수 론할 수 있습니다.</p><div class="ability-selected">선택: ${localKaijiTiles.map(tileLabel).join(' · ')||'없음'} <b>${ready?'준비 완료':'2장 선택 필요'}</b></div><div id="kaijiTilePicker" class="ability-tile-picker"></div>`;
    const picker=$('kaijiTilePicker');
    for(let t=0;t<34;t++){
      const el=renderTile(t,'tile ability-tile'+(localKaijiTiles.includes(t)?' selected':'')+(waits.has(t)?' disabled':'') );
      el.title=waits.has(t)?`${tileLabel(t)} · 현재 대기패라 선택 불가`:tileLabel(t);
      el.onclick=()=>{
        if(waits.has(t))return toast('현재 대기패는 특수 론패로 지정할 수 없습니다.');
        if(localKaijiTiles.includes(t)){localKaijiTiles=localKaijiTiles.filter(x=>x!==t);}
        else {if(localKaijiTiles.length>=2)return toast('특수 론패는 2장까지입니다.');localKaijiTiles.push(t);}
        socket.emit('set_kaiji_tiles',{tiles:localKaijiTiles}); renderAbilityPanel(state);
      };
      picker.appendChild(el);
    }
  } else if(ch==='MURAOKA'){
    const rows=(s.me.murauokaReveal||[]).map(x=>waitTileMarkup(x.tile,x.count)).join('');
    box.innerHTML=`<div class="ability-title">${s.me.characterName} · 패산 간파</div><p>상대 패산에서 무작위로 정해진 8종류의 패와 각 종류의 총 보유 매수를 알 수 있습니다. 텐파이 여부는 알 수 없습니다.</p><div class="revealed-count">공개된 10장 <span>${rows||'표시 준비 중'}</span></div>`;
  } else if(ch==='WASHIZU'){
    box.innerHTML=`<div class="ability-title">${s.me.characterName} · 위압감</div><p>상대는 자신의 <b>9번째 타패까지</b> 요구패(1·9·자패)를 버릴 수 없습니다.</p><div class="ability-ready">특수능력 자동 적용</div>`;
  } else if(ch==='AKAGI'){
    const suitNames={m:'만수',p:'통수',s:'삭수'};
    box.innerHTML=`<div class="ability-title">${s.me.characterName} · 절일문</div><p>만수·통수·삭수 중 하나를 골라 상대가 그 수패를 버릴 수 없게 합니다. 단, 그 수패만 남으면 버릴 수 있습니다.</p><div class="suit-picker">${Object.entries(suitNames).map(([k,v])=>`<button class="suit-btn ${s.me.akagiSuit===k?'selected':''}" data-suit="${k}">${v}</button>`).join('')}</div><div class="ability-ready">${s.me.akagiSuit?suitNames[s.me.akagiSuit]+' 금지 적용':'수패를 선택하세요.'}</div>`;
    box.querySelectorAll('.suit-btn').forEach(btn=>btn.onclick=()=>socket.emit('set_akagi_suit',{suit:btn.dataset.suit}));
  }
  const chReady=ch==='MURAOKA'||ch==='WASHIZU'||!!s.me.abilityReady || (ch==='KAIJI'&&localKaijiTiles.length===2) || (ch==='AKAGI'&&!!s.me.akagiSuit);
}

function startSetup(s){
  const wall=s.me.private34Tiles||[];
  // The server sends tile types only. When restoring an existing selection,
  // map each occurrence to a concrete position in this 34-tile wall.
  if (lastPhase !== 'SETUP' && !(s.me?.setupConfirmed)) {
    localKaijiTiles=[...(s.me?.specialRonTiles||[])];
    setupPreview=[];
    const used=new Set();
    localSelected=[];
    for(const t of (s.me?.hand13||[])){
      const wallIndex=wall.findIndex((wt,i)=>wt===t&&!used.has(i));
      if(wallIndex>=0){used.add(wallIndex);localSelected.push({tile:t,wallIndex});}
    }
  }
  $('stakeSetup').textContent=money(s.stake); $('setupMyMoney').textContent=money(s.me.money); $('setupOpponentMoney').textContent=money(s.opponent?.money);
  setTileContent($('setupDora'),s.doraIndicator,'tile-mini');
  setTileContent($('setupDoraBig'),s.doraIndicator,'tile-mini');
  const setupActual=doraFromIndicatorLocal(s.doraIndicator);
  setTileContent($('setupDoraActual'),setupActual,'tile-mini');
  setTileContent($('setupDoraBigActual'),setupActual,'tile-mini');
  const container=$('privateWall'); container.innerHTML='';
  // Keep the physical wallIndex for duplicate-tile identity, but DISPLAY in canonical tile order.
  const wallInstances=sortTileInstances(wall.map((tile,wallIndex)=>({tile,wallIndex})));
  wallInstances.forEach(({tile:t,wallIndex})=>{
    const el=renderTile(t);
    el.dataset.wallIndex=wallIndex;
    if(localSelected.some(x=>x.wallIndex===wallIndex)) el.classList.add('selected');
    el.onclick=()=>toggleSelection(t,wallIndex,el);
    container.appendChild(el);
  });
  renderSelected(); updateSetupTimer(s.setupEndsAt); renderAbilityPanel(s);
  const confirm=$('confirmHandBtn'); const locked=!!s.me.setupConfirmed; const canUnlock=locked && !s.opponent?.setupConfirmed;
  const ch=s.me.character;
  const chReady=ch==='MURAOKA'||ch==='WASHIZU'||ch==null||(ch==='KAIJI'&&localKaijiTiles.length===2)||(ch==='AKAGI'&&!!s.me.akagiSuit);
  confirm.textContent=locked?(canUnlock?'확정 취소하고 다시 선택':'확정 완료'): '13장 확정';
  // 13장을 고르면 버튼은 항상 클릭 가능하게 한다. 캐릭터 특수능력 조건은
  // 클릭 핸들러와 서버에서 구체적인 이유를 안내한다. disabled 때문에
  // '13장을 다 골랐는데 아무 반응도 없는' 상태가 생기지 않게 한다.
  confirm.disabled=locked ? !canUnlock : (localSelected.length!==13);
  $('cancelAllSetupBtn').disabled=locked; show('setup');
  const oppInfo=$('opponentCharacterInfo');
  if(oppInfo){
    if(s.gameMode==='CHARACTER' && s.opponent?.characterName){
      oppInfo.classList.remove('hidden');
      oppInfo.innerHTML=`<b>상대 캐릭터 · ${s.opponent.characterName}</b><span>특수능력: ${s.opponent.characterAbility||'특수능력 없음'}</span>`;
    } else { oppInfo.classList.add('hidden'); oppInfo.innerHTML=''; }
  }
  socket.emit('preview_setup',{tiles:localSelected.map(x=>x.tile)});
}
function toggleSelection(t,wallIndex,el){
  if(state?.me?.setupConfirmed) return;
  const index=localSelected.findIndex(x=>x.wallIndex===wallIndex);
  if(index>=0){
    localSelected.splice(index,1);
    el.classList.remove('selected');
  } else {
    if(localSelected.length>=13){toast('13장까지만 선택할 수 있습니다.');return}
    localSelected.push({tile:t,wallIndex});
    el.classList.add('selected');
  }
  renderSelected();
  if(state) renderAbilityPanel(state);
  socket.emit('preview_setup',{tiles:localSelected.map(x=>x.tile)});
}
function remainingWaitCount(tile, hand){
  const own=(hand||[]).filter(t=>t===tile).length;
  const dora=(state?.doraIndicator===tile)?1:0;
  return Math.max(0,4-own-dora);
}
function waitTileMarkup(tile, count){
  return `<span class=\"wait-count-tile\" title=\"${tileLabel(tile)} · 남은 ${count}장\"><span class=\"wait-count-img\">${tileImageMarkup(tile)}</span><b>×${count}</b></span>`;
}
function renderWaitTiles(container, waits, hand){
  container.innerHTML='';
  if(!waits?.length){container.textContent='대기패 없음';return;}
  waits.forEach(t=>container.insertAdjacentHTML('beforeend',waitTileMarkup(t,remainingWaitCount(t,hand))));
}

function renderSelected(){
  $('selectedCount').textContent=localSelected.length;
  $('selectedHand').title='선택한 패를 클릭하면 선택이 취소됩니다.';
  const box=$('selectedHand'); box.innerHTML='';
  // Show the chosen 13 in the same canonical order as the tile wall.
  sortTileInstances(localSelected).forEach(x=>{
    const el=renderTile(x.tile,'tile selected');
    el.dataset.wallIndex=x.wallIndex;
    el.title=`${tileLabel(x.tile)} · 클릭해서 선택 취소`;
    el.onclick=()=>{
      if(state?.me?.setupConfirmed) return;
      const idx=localSelected.findIndex(v=>v.wallIndex===x.wallIndex);
      if(idx<0) return;
      localSelected.splice(idx,1);
      socket.emit('preview_setup',{tiles:localSelected.map(v=>v.tile)});
      const wallEl=document.querySelector(`#privateWall .tile[data-wall-index=\"${x.wallIndex}\"]`);
      if(wallEl) wallEl.classList.remove('selected');
      renderSelected();
      if(state) renderAbilityPanel(state);
    };
    box.appendChild(el);
  });
  const counts=Array(34).fill(0); localSelected.forEach(x=>counts[x.tile]++);
  const waits=[]; if(localSelected.length===13){for(let t=0;t<34;t++){if(counts[t]>=4)continue;counts[t]++;if(isAgariLocal(counts))waits.push(t);counts[t]--;}}
  const waitsBox=$('waits');
  waitsBox.innerHTML='';
  if(localSelected.length===13 && waits.length){
    const label=document.createElement('span'); label.className='waits-heading'; label.textContent='대기패 · 남은 매수'; waitsBox.appendChild(label);
    const row=document.createElement('span'); row.className='wait-count-row'; waitsBox.appendChild(row);
    waits.forEach(t=>row.insertAdjacentHTML('beforeend',waitTileMarkup(t,remainingWaitCount(t,localSelected.map(x=>x.tile)))));
  } else {
    waitsBox.textContent=localSelected.length===13?'대기패가 없습니다.':'13장 선택 후 텐파이를 확인합니다.';
  }
  const chip=$('tenpaiStatus'); chip.className='status-chip '+(waits.length?'good':'bad'); chip.textContent=localSelected.length===13?(waits.length?'텐파이':'노텐'):'판정 전';
  renderSetupPreview();
}
function renderSetupPreview(){
  const box=$('waitPreviewList'); if(!box)return; box.innerHTML='';
  if(localSelected.length!==13){box.innerHTML='<div class="preview-empty">13장을 모두 선택하면 대기패별 예상 역을 보여줍니다.</div>';return;}
  if(!setupPreview.length){box.innerHTML='<div class="preview-empty">텐파이 대기패가 없습니다.</div>';return;}
  setupPreview.forEach(item=>{
    const row=document.createElement('div'); row.className='wait-preview-row';
    const tile=document.createElement('div'); tile.className='wait-preview-tile'; tile.appendChild(renderTile(item.tile,'tile-mini'));
    const body=document.createElement('div'); body.className='wait-preview-body';
    const title=document.createElement('strong'); title.textContent=`${tileLabel(item.tile)} 대기 · ${item.han}판${item.fu?` ${item.fu}부`:''}`;
    const y=document.createElement('div'); y.className='wait-preview-yaku'; y.textContent=previewYakuText(item);
    const status=document.createElement('span'); status.className=item.allowed?'preview-ok':'preview-no'; status.textContent=item.allowed?'만관 이상 · 론 가능':'만관 미달 · 론 불가';
    body.append(title,y,status); row.append(tile,body); box.appendChild(row);
  });
}

function isChiitoiLocal(c){return c.filter(n=>n===2).length===7&&c.every(n=>n===0||n===2)}
function isKokushiLocal(c){const yaos=[0,8,9,17,18,26,27,28,29,30,31,32,33];let p=false;for(const t of yaos){if(!c[t])return false;if(c[t]>=2)p=true}for(let t=0;t<34;t++)if(!yaos.includes(t)&&c[t])return false;return p}
function isStdLocal(c){const a=c.slice();function rec(pos,pair,groups){while(pos<34&&!a[pos])pos++;if(pos===34)return pair&&groups===4;if(!pair&&a[pos]>=2){a[pos]-=2;if(rec(pos,true,groups))return true;a[pos]+=2}if(a[pos]>=3){a[pos]-=3;if(rec(pos,pair,groups+1))return true;a[pos]+=3}if(pos<27&&pos%9<=6&&a[pos+1]&&a[pos+2]){a[pos]--;a[pos+1]--;a[pos+2]--;if(rec(pos,pair,groups+1))return true;a[pos]++;a[pos+1]++;a[pos+2]++}return false}return rec(0,false,0)}
function isAgariLocal(c){return isKokushiLocal(c)||isChiitoiLocal(c)||isStdLocal(c)}
function updateSetupTimer(end){clearInterval(setupTimerHandle);const tick=()=>{const ms=Math.max(0,end-Date.now());const sec=Math.ceil(ms/1000);$('setupTimer').textContent=ms<=0?'⌛ 00:00 · 랜덤 13장 강제 시작':`⌛ ${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;if(ms<=0)clearInterval(setupTimerHandle)};tick();setupTimerHandle=setInterval(tick,250)}

function renderDiscardGrid(container, tiles, riichiIndex){
  container.innerHTML='';
  (tiles||[]).forEach((t,i)=>{
    const el=renderTile(t,'tile discard-tile'+(i===riichiIndex?' riichi-discard':''));
    el.title=i===riichiIndex?`${tileLabel(t)} · 리치 선언패`:tileLabel(t);
    container.appendChild(el);
  });
}
function renderTurnTimer(end){ clearInterval(turnTimerHandle); const tick=()=>{const ms=Math.max(0,(end||0)-Date.now()); const sec=Math.ceil(ms/1000); $('turnTimer').textContent=sec>0?`⏱ ${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`:'⏱ 00:00'; if(ms<=0)clearInterval(turnTimerHandle)}; tick(); turnTimerHandle=setInterval(tick,250); }
function renderRonAlert(s){ const box=$('ronAlert'); const ron=$('ronBtn'); const active=!!s.canRon; box.classList.toggle('hidden',!active); if(active){box.innerHTML='<b>RON!</b><span>이 패는 화료패입니다.</span>'; box.classList.add('flash'); ron.classList.add('ron-pulse');} else {box.innerHTML='';box.classList.remove('flash');ron.classList.remove('ron-pulse');} }
function renderGame(s){
  show('game');
  $('roomInGame').textContent='ROOM '+s.code;
  $('stakeGame').textContent=money(s.stake);
  $('myMoney').textContent=money(s.me.money);
  $('opponentMoney').textContent=money(s.opponent?.money);
  $('mySeat').textContent=s.me.seat==='EAST'?'동':'서';
  $('opponentName').textContent=s.opponent?.nickname||'상대';
  if($('opponentRiichi')) $('opponentRiichi').title=s.opponent?.characterName||'';
  $('opponentSeat').textContent=s.opponent?.seat==='EAST'?'동':'서';
  $('opponentCount').textContent=`${s.opponent?.discardCount||0}/17`;
  setTileContent($('doraGame'),s.doraIndicator,'tile-mini');
  const doraActual=s.doraTile??(s.doraIndicator==null?null:doraFromIndicatorLocal(s.doraIndicator));
  if(doraActual!=null) setTileContent($('doraActual'),doraActual,'tile-mini');
  $('opponentRiichi').textContent=s.opponent?.isRiichi?'리치':'-';
  $('myRiichi').textContent=s.me.isRiichi?'리치':'리치 아님';
  $('myTenpai').textContent=s.me.isTenpai?'텐파이':'노텐';
  $('myFuriten').textContent=s.me.furiten?'후리텐':(s.me.temporaryFuriten?'일시 후리텐':'');
  $('discardProgress').textContent=`${s.me.discardCount}/17`;
  $('turnIndicator').textContent=s.turn===s.me.seat?'내 턴':'상대 턴'; renderTurnTimer(s.turnEndsAt); renderRonAlert(s);
  renderDiscardGrid($('opponentDiscards'),s.opponent?.discardedTiles||[],s.opponent?.riichiDiscardIndex);
  renderDiscardGrid($('myDiscards'),s.me.discardedTiles||[],s.me.riichiDiscardIndex);
  const cand=$('candidates'); cand.innerHTML=''; sortTiles(s.me.discardCandidates||[]).forEach(t=>{const el=renderTile(t);el.onclick=()=>{if(s.ronBlockEndsAt && Date.now()<s.ronBlockEndsAt)return toast('론 확인 중입니다. 잠시 기다려주세요.'); if(s.turn!==s.me.seat)return toast('상대 턴입니다.');socket.emit('discard_tile',{tile:t})};cand.appendChild(el)});
  const hand=$('myHand');hand.innerHTML='';sortTiles(s.me.hand13||[]).forEach(t=>hand.appendChild(renderTile(t,'tile')));
  const waitBox=$('gameWaits');
  waitBox.innerHTML='';
  (s.me.waits||[]).forEach(t=>{
    const count=Number(s.me.waitRemaining?.[t] ?? Math.max(0,4-(s.me.hand13||[]).filter(x=>x===t).length-(s.doraIndicator===t?1:0)));
    waitBox.insertAdjacentHTML('beforeend',waitTileMarkup(t,count));
  });
  const ld=$('lastDiscard'); if(s.lastDiscard!=null){ld.classList.remove('hidden');setTileContent(ld,s.lastDiscard,'tile last-discard-tile')} else {ld.classList.add('hidden');ld.innerHTML=''}
  $('candidateCount').textContent=s.me.discardCandidates?.length??0;
  const ron=$('ronBtn');ron.disabled=!s.canRon;ron.title=s.ronReason||''; if(s.ronBlockEndsAt && Date.now()<s.ronBlockEndsAt && s.turn===s.me.seat) cand.classList.add('discard-blocked'); else cand.classList.remove('discard-blocked');
}

function renderResultHand(title, view, winningTile=null){
  if(!view) return '';
  const hand=[...(view.hand13||[])];
  const tiles=hand.map((t)=>`<span class=\"result-hand-tile\">${tileImageMarkup(t)}</span>`).join('');
  const win=winningTile!=null ? `<span class=\"result-win-plus\">＋</span><span class=\"result-hand-tile result-winning-tile\">${tileImageMarkup(winningTile)}</span>` : '';
  const waits=(view.waits||[]).map(t=>`<span class=\"result-wait-tile\">${tileImageMarkup(t)}</span>`).join('');
  return `<div class=\"result-hand-block\"><div class=\"result-hand-title\">${title}</div><div class=\"result-hand-row\">${tiles}${win}</div><div class=\"result-waits-label\">${view.tenpai?'텐파이 · 대기패':'노텐'} ${waits?`<span class=\"result-waits\">${waits}</span>`:''}</div></div>`;
}
function tileImageMarkup(t){
  return `<img src=\"/assets/tiles/${t}.png\" alt=\"${tileLabel(t)}\" onerror=\"this.style.display='none'\">`;
}
function startResultCountdown(endAt, gameOver=false){
  clearInterval(resultTimerHandle);
  const tick=()=>{
    const ms=Math.max(0,(endAt||0)-Date.now());
    const sec=Math.ceil(ms/1000);
    if(gameOver){
      $('resultCountdown').textContent='대국 종료';
    } else if(sec>0){
      $('resultCountdown').textContent=`${sec}초 후 자동으로 다음 판 · 두 명 모두 누르면 즉시 시작`;
    } else {
      $('resultCountdown').textContent='다음 판을 시작합니다.';
    }
    if(ms<=0){clearInterval(resultTimerHandle);resultTimerHandle=null;}
  };
  tick();
  if(!gameOver) resultTimerHandle=setInterval(tick,250);
}
function renderNextRoundControls(s,r){
  const btn=$('nextRoundBtn'); const status=$('nextRoundStatus');
  if(r?.gameOver){
    btn.classList.add('hidden'); status.classList.add('hidden'); $('restartGameBtn').classList.remove('hidden'); return;
  }
  $('restartGameBtn').classList.add('hidden');
  btn.classList.remove('hidden'); status.classList.remove('hidden');
  const ready=!!s.me?.nextReady;
  const count=Number(s.nextReadyCount||0);
  btn.disabled=ready;
  btn.textContent=ready?'다음 판 대기중…':'다음 판 하기';
  status.textContent=ready?`다음 판 준비 완료 · 상대 ${count>=2?'준비 완료':'준비 대기중'}`:'두 명 모두 누르면 즉시 다음 판이 시작됩니다.';
}

function renderResult(s){
  show('result'); const r=s.result;
  startResultCountdown(r?.resultEndsAt||Date.now(),!!r?.gameOver);
  renderNextRoundControls(s,r);
  const final=r?.gameOver;
  let mainLabel=r?.type==='RON'?classKo(r.classification):'유국';
  if(final){
    if(r.finalWinner===s.me.seat) mainLabel='최종 승리';
    else if(r.finalLoser===s.me.seat) mainLabel='최종 패배';
    else mainLabel='대국 종료';
  }
  $('resultMain').textContent=mainLabel;
  $('resultMain').className='result-rank '+rarityClass(mainLabel)+(final?' final-result-rank':'');
  $('resultTitle').textContent=final?'FINAL RESULT':'GAME RESULT';
  const handBox=$('resultHandView');
  if(r?.type==='RON'){
    const winnerName=r.winner===s.me.seat?s.me.nickname:(s.opponent?.nickname||'상대');
    const loserName=r.loser===s.me.seat?s.me.nickname:(s.opponent?.nickname||'상대');
    const finalLine=final?`<div class=\"final-money-line\">${loserName}의 보유금이 0원이 되어 대국이 종료됩니다.</div>`:'';
    const specialLine=r.special?'<div class=\"special-result-line\">카이지 특수능력으로 강제 론</div>':'';
    $('resultDetail').innerHTML=`<div class=\"result-burst ${final?'final-burst':''}"><b>${r.winner===s.me.seat?'승리':'패배'}</b></div><div>${winnerName} 승 · ${loserName} 패</div><div class=\"payment-line\">${loserName} → ${winnerName} <b>${money(r.payment)}</b></div><div>${r.han}판 ${r.fu? r.fu+'부':''}</div><div>기본 ${r.baseHan}판 · 도라 ${r.dora} · 우라도라 ${r.ura}</div>${specialLine}${finalLine}<div class=\"ura-result\"><span>우라도라표시패</span><span id=\"resultUraTile\"></span></div>`;
    if(r.uraIndicator!=null) setTileContent($('resultUraTile'),r.uraIndicator,'tile ura-big');
    handBox.innerHTML=renderResultHand(`${winnerName}의 화료 형태 · 론패 포함`,r.winnerHand,r.tile);
    const yl=$('yakuList');yl.innerHTML='';(r.yaku||[]).forEach(y=>{const x=document.createElement('div');x.className='yaku '+yakuRarity(Number(y[1])||0);x.innerHTML=`<b>${yakuKo(y[0])}</b><span>${y[1]}판</span>`;yl.appendChild(x)});
  } else {
    const finalLine=final?(r.finalWinner?`<div class=\"final-money-line\">${r.finalWinner===s.me.seat?'상대의 보유금이 0원이 되어 최종 승리했습니다.':'내 보유금이 0원이 되어 최종 패배했습니다.'}</div>`:'<div class=\"final-money-line\">양쪽 보유금이 모두 0원이 되어 대국이 종료됩니다.</div>'):'';
    $('resultDetail').innerHTML=`<div>양쪽 모두 17장까지 타패했습니다.</div><div>서로의 텐파이와 대기패를 확인하세요.</div><div>각자 현재 판돈 <b>${money(r.previousStake||r.nextStake/2)}</b>를 내고 다음 판 판돈은 <b>${money(r.nextStake)}</b>입니다. ${r.cappedStake?'상대 잔액에 맞춘 마지막 라운드입니다.':''}</div><div class=\"money-result\"><span>내 보유금 ${money(s.me.money)}</span><span>상대 보유금 ${money(s.opponent?.money)}</span></div>${finalLine}`;
    const myView=s.me.seat==='EAST'?r.east:r.west; const oppView=s.me.seat==='EAST'?r.west:r.east;
    handBox.innerHTML=renderResultHand(`${s.me.nickname} · ${myView?.tenpai?'텐파이':'노텐'}`,myView)+renderResultHand(`${s.opponent?.nickname||'상대'} · ${oppView?.tenpai?'텐파이':'노텐'}`,oppView);
    $('yakuList').innerHTML='';
  }
}

socket.on('restart_done',()=>location.reload());
socket.on('room_created',({code})=>{show('lobby');$('roomCodeLobby').textContent=code;$('bigRoomCode').textContent=code});
socket.on('joined_room',({code})=>toast(`${code} 방에 참가했습니다.`));
socket.on('notice',msg=>toast(msg));
socket.on('dora_pool',()=>{});
socket.on('dora_reveal',({dora,endsAt})=>{ clearInterval(doraRevealHandle); show('dora'); $('doraRevealStage').classList.remove('revealing'); $('doraRevealText').textContent='패산을 섞고 운명의 한 장을 결정합니다…'; $('doraRevealTile').innerHTML=''; const back=document.createElement('div'); back.className='dora-reveal-back'; back.textContent='DO RA'; $('doraRevealTile').appendChild(back); setTimeout(()=>{ $('doraRevealTile').innerHTML=''; $('doraRevealTile').appendChild(renderTile(dora,'tile dora-reveal-card')); $('doraRevealStage').classList.add('revealing'); },650); const tick=()=>{const ms=Math.max(0,endsAt-Date.now()); if(ms<=0){clearInterval(doraRevealHandle); $('doraRevealText').textContent=`도라표시패 · ${tileLabel(dora)} · 자동 공개 완료`; $('doraRevealStage').classList.remove('revealing');}};tick();doraRevealHandle=setInterval(tick,100); });
socket.on('dora_selected',({dora})=>{ $('doraWait').classList.remove('hidden'); $('doraWait').innerHTML=''; $('doraWait').append('도라표시패: '); $('doraWait').appendChild(renderTile(dora,'tile-mini')); });
socket.on('ron_reveal',({winner,loser,tile,endsAt})=>{ clearInterval(ronRevealHandle); const box=$('ronAlert'); box.classList.remove('hidden'); box.classList.add('flash'); box.innerHTML=`<b>${winner===state?.me?.seat?'RON!':'RON 당함!'}</b><span>${tileLabel(tile)} · 화료 연출 중</span>`; const tick=()=>{if(Date.now()>=endsAt){clearInterval(ronRevealHandle);return;} };tick();ronRevealHandle=setInterval(tick,100); });
socket.on('setup_preview',data=>{setupPreview=data?.waits||[];renderSetupPreview();});
socket.on('state',s=>{
  const previousPhase=lastPhase;
  state=s;
  if(s.phase==='WAITING'){renderLobby(s);show('lobby');}
  else if(s.phase==='CHARACTER_DRAW') renderCharacterDraw(s);
  else if(s.phase==='CHARACTER_SELECT') renderCharacter(s);
  else if(s.phase==='DORA_REVEAL') {show('dora');$('doraRoom').textContent='ROOM '+s.code;} else if(s.phase==='DORA_SELECT') {show('dora');$('doraRoom').textContent='ROOM '+s.code;}
  else if(s.phase==='SETUP') startSetup(s);
  else if(s.phase==='PLAYING'||s.phase==='RON_REVEAL') renderGame(s);
  else if(s.phase==='RESULT'||s.phase==='DRAW') renderResult(s);
  lastPhase=s.phase;
});
socket.on('error_message',msg=>toast(msg));
