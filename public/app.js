const socket = io();
let state = null;
let localSelected = []; // [{tile, wallIndex}] - physical tile instances, not just tile types
let lastPhase = null;
let setupTimerHandle = null;
let setupPreview = [];
let resultTimerHandle = null;

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
  '清老頭':'청노두','字一色':'자일색','大三元':'대삼원','ドラ':'도라','裏ドラ':'우라도라'
};
function yakuKo(name){
  if(name.startsWith('役牌 ')) return `자풍패(${name.slice(3).replace('東','동').replace('南','남').replace('西','서').replace('北','북')})`;
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

$('createBtn').onclick=()=>socket.emit('create_room',{nickname:$('nickname').value.trim()||'Player 1',stake:Number($('stake').value)||1000000});
$('joinBtn').onclick=()=>socket.emit('join_room',{nickname:$('nickname').value.trim()||'Player 2',code:$('joinCode').value.trim()});
$('copyRoomBtn').onclick=async()=>{await navigator.clipboard?.writeText($('bigRoomCode').textContent); toast('방 코드를 복사했습니다.')};
$('confirmHandBtn').onclick=()=>{
  if(localSelected.length!==13){toast('13장을 선택하세요.');return}
  socket.emit('confirm_hand',{tiles:localSelected.map(x=>x.tile)});
};
$('ronBtn').onclick=()=>socket.emit('declare_ron');
$('passRonBtn').onclick=()=>socket.emit('pass_ron');
$('nextRoundBtn').onclick=()=>socket.emit('next_round');

function renderLobby(s){
  $('roomCodeLobby').textContent=s.code; $('bigRoomCode').textContent=s.code;
  $('eastName').textContent=s.me?.seat==='EAST'?s.me?.nickname:(s.opponent?.seat==='EAST'?s.opponent?.nickname:'-');
  $('westName').textContent=s.me?.seat==='WEST'?s.me?.nickname:(s.opponent?.seat==='WEST'?s.opponent?.nickname:'-');
  $('westStatus').textContent=s.opponent?'READY':'WAITING';
}
function startSetup(s){
  const wall=s.me.private34Tiles||[];
  // The server sends tile types only. When restoring an existing selection,
  // map each occurrence to a concrete position in this 34-tile wall.
  if (lastPhase !== 'SETUP' && !(s.me?.setupConfirmed)) {
    setupPreview=[];
    const used=new Set();
    localSelected=[];
    for(const t of (s.me?.hand13||[])){
      const wallIndex=wall.findIndex((wt,i)=>wt===t&&!used.has(i));
      if(wallIndex>=0){used.add(wallIndex);localSelected.push({tile:t,wallIndex});}
    }
  }
  $('stakeSetup').textContent=money(s.stake);
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
  renderSelected(); updateSetupTimer(s.setupEndsAt); show('setup');
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
  socket.emit('preview_setup',{tiles:localSelected.map(x=>x.tile)});
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
      const wallEl=document.querySelector(`#privateWall .tile[data-wall-index=\"${x.wallIndex}\"]`);
      if(wallEl) wallEl.classList.remove('selected');
      renderSelected();
    };
    box.appendChild(el);
  });
  const counts=Array(34).fill(0); localSelected.forEach(x=>counts[x.tile]++);
  const waits=[]; if(localSelected.length===13){for(let t=0;t<34;t++){if(counts[t]>=4)continue;counts[t]++;if(isAgariLocal(counts))waits.push(t);counts[t]--;}}
  $('waits').textContent=waits.length?`대기: ${waits.map(tileLabel).join(' · ')}`:'대기패를 계산할 수 없습니다.';
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
function updateSetupTimer(end){clearInterval(setupTimerHandle);const tick=()=>{const ms=Math.max(0,end-Date.now());const sec=Math.ceil(ms/1000);$('setupTimer').textContent=`⌛ ${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;if(ms<=0)clearInterval(setupTimerHandle)};tick();setupTimerHandle=setInterval(tick,250)}

function renderDiscardGrid(container, tiles, riichiIndex){
  container.innerHTML='';
  (tiles||[]).forEach((t,i)=>{
    const el=renderTile(t,'tile discard-tile'+(i===riichiIndex?' riichi-discard':''));
    el.title=i===riichiIndex?`${tileLabel(t)} · 리치 선언패`:tileLabel(t);
    container.appendChild(el);
  });
}
function renderGame(s){
  show('game');
  $('roomInGame').textContent='ROOM '+s.code;
  $('stakeGame').textContent=money(s.stake);
  $('myMoney').textContent=money(s.me.money);
  $('opponentMoney').textContent=money(s.opponent?.money);
  $('mySeat').textContent=s.me.seat==='EAST'?'동':'서';
  $('opponentName').textContent=s.opponent?.nickname||'상대';
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
  $('turnIndicator').textContent=s.turn===s.me.seat?'내 턴':'상대 턴';
  renderDiscardGrid($('opponentDiscards'),s.opponent?.discardedTiles||[],s.opponent?.riichiDiscardIndex);
  renderDiscardGrid($('myDiscards'),s.me.discardedTiles||[],s.me.riichiDiscardIndex);
  const cand=$('candidates'); cand.innerHTML=''; sortTiles(s.me.discardCandidates||[]).forEach(t=>{const el=renderTile(t);el.onclick=()=>{if(s.turn!==s.me.seat)return toast('상대 턴입니다.');socket.emit('discard_tile',{tile:t})};cand.appendChild(el)});
  const hand=$('myHand');hand.innerHTML='';sortTiles(s.me.hand13||[]).forEach(t=>hand.appendChild(renderTile(t,'tile')));
  const waitBox=$('gameWaits'); waitBox.innerHTML=''; (s.me.waits||[]).forEach(t=>{const x=renderTile(t,'tile-mini wait-icon');x.title=`론패 ${tileLabel(t)}`;waitBox.appendChild(x)});
  const ld=$('lastDiscard'); if(s.lastDiscard!=null){ld.classList.remove('hidden');setTileContent(ld,s.lastDiscard,'tile last-discard-tile')} else {ld.classList.add('hidden');ld.innerHTML=''}
  $('candidateCount').textContent=s.me.discardCandidates?.length??0;
  const ron=$('ronBtn');ron.disabled=!s.canRon;ron.title=s.ronReason||'';
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
function startResultCountdown(endAt){
  clearInterval(resultTimerHandle);
  const tick=()=>{
    const ms=Math.max(0,(endAt||0)-Date.now());
    const sec=Math.ceil(ms/1000);
    $('resultCountdown').textContent=sec>0?`다음 판까지 ${sec}초 · 결과를 확인하세요`:'다음 판을 시작할 수 있습니다.';
    $('nextRoundBtn').disabled=sec>0;
    if(ms<=0){clearInterval(resultTimerHandle);resultTimerHandle=null;}
  };
  tick();
  resultTimerHandle=setInterval(tick,250);
}

function renderResult(s){
  show('result'); const r=s.result;
  startResultCountdown(r?.resultEndsAt||Date.now());
  $('resultMain').textContent=r?.type==='RON'?classKo(r.classification):'유국';
  $('resultMain').className='result-rank '+rarityClass($('resultMain').textContent);
  const handBox=$('resultHandView');
  if(r?.type==='RON'){
    const winnerName=r.winner===s.me.seat?s.me.nickname:(s.opponent?.nickname||'상대');
    const loserName=r.loser===s.me.seat?s.me.nickname:(s.opponent?.nickname||'상대');
    $('resultDetail').innerHTML=`<div class=\"result-burst\"><b>${r.winner===s.me.seat?'승리':'패배'}</b></div><div>${winnerName} 승 · ${loserName} 패</div><div class=\"payment-line\">${loserName} → ${winnerName} <b>${money(r.payment)}</b></div><div>${r.han}판 ${r.fu? r.fu+'부':''}</div><div>기본 ${r.baseHan}판 · 도라 ${r.dora} · 우라도라 ${r.ura}</div>`;
    handBox.innerHTML=renderResultHand(`${winnerName}의 화료 형태 · 론패 포함`,r.winnerHand,r.tile);
    const yl=$('yakuList');yl.innerHTML='';(r.yaku||[]).forEach(y=>{const x=document.createElement('div');x.className='yaku '+yakuRarity(Number(y[1])||0);x.innerHTML=`<b>${yakuKo(y[0])}</b><span>${y[1]}판</span>`;yl.appendChild(x)});
  } else {
    $('resultDetail').innerHTML=`<div>양쪽 모두 17장까지 타패했습니다.</div><div>서로의 텐파이와 대기패를 확인하세요.</div><div>각자 현재 판돈 <b>${money(r.nextStake/2)}</b>를 내고 다음 판 판돈이 <b>${money(r.nextStake)}</b>로 올라갑니다.</div><div class=\"money-result\"><span>내 보유금 ${money(s.me.money)}</span><span>상대 보유금 ${money(s.opponent?.money)}</span></div>`;
    const myView=s.me.seat==='EAST'?r.east:r.west; const oppView=s.me.seat==='EAST'?r.west:r.east;
    handBox.innerHTML=renderResultHand(`${s.me.nickname} · ${myView?.tenpai?'텐파이':'노텐'}`,myView)+renderResultHand(`${s.opponent?.nickname||'상대'} · ${oppView?.tenpai?'텐파이':'노텐'}`,oppView);
    $('yakuList').innerHTML='';
  }
}

socket.on('room_created',({code})=>{show('lobby');$('roomCodeLobby').textContent=code;$('bigRoomCode').textContent=code});
socket.on('joined_room',({code})=>toast(`${code} 방에 참가했습니다.`));
socket.on('notice',msg=>toast(msg));
socket.on('dora_pool',({poolSize})=>{
  const box=$('doraPool');box.innerHTML='';for(let i=0;i<poolSize;i++){const b=document.createElement('button');b.className='dora-back';b.textContent=(i+1);b.onclick=()=>socket.emit('select_dora',{index:i});box.appendChild(b)}
});
socket.on('dora_selected',({dora})=>{ $('doraWait').classList.remove('hidden'); $('doraWait').innerHTML=''; $('doraWait').append('도라표시패: '); $('doraWait').appendChild(renderTile(dora,'tile-mini')); });
socket.on('setup_preview',data=>{setupPreview=data?.waits||[];renderSetupPreview();});
socket.on('state',s=>{
  const previousPhase=lastPhase;
  state=s;
  if(s.phase==='WAITING'){renderLobby(s);show('lobby');}
  else if(s.phase==='DORA_SELECT') {show('dora');$('doraRoom').textContent='ROOM '+s.code; const isDealer=s.dealer===s.me?.seat;$('doraWait').classList.toggle('hidden',isDealer);}
  else if(s.phase==='SETUP') startSetup(s);
  else if(s.phase==='PLAYING') renderGame(s);
  else if(s.phase==='RESULT'||s.phase==='DRAW') renderResult(s);
  lastPhase=s.phase;
});
socket.on('error_message',msg=>toast(msg));
