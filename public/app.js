const socket = io();
let state = null;
let localSelected = []; // [{tile, wallIndex}] - physical tile instances, not just tile types
let lastPhase = null;
let setupTimerHandle = null;

const $ = id => document.getElementById(id);
const screens = [...document.querySelectorAll('.screen')];
function show(screenId){screens.forEach(s=>s.classList.toggle('active',s.id===screenId)); window.scrollTo(0,0)}
function money(n){return Number(n||0).toLocaleString('ko-KR')+'원'}
const TILE_LABELS=['1萬','2萬','3萬','4萬','5萬','6萬','7萬','8萬','9萬','1筒','2筒','3筒','4筒','5筒','6筒','7筒','8筒','9筒','1索','2索','3索','4索','5索','6索','7索','8索','9索','東','南','西','北','白','發','中'];
function tileLabel(t){return TILE_LABELS[t]||''}
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
}
function isChiitoiLocal(c){return c.filter(n=>n===2).length===7&&c.every(n=>n===0||n===2)}
function isKokushiLocal(c){const yaos=[0,8,9,17,18,26,27,28,29,30,31,32,33];let p=false;for(const t of yaos){if(!c[t])return false;if(c[t]>=2)p=true}for(let t=0;t<34;t++)if(!yaos.includes(t)&&c[t])return false;return p}
function isStdLocal(c){const a=c.slice();function rec(pos,pair,groups){while(pos<34&&!a[pos])pos++;if(pos===34)return pair&&groups===4;if(!pair&&a[pos]>=2){a[pos]-=2;if(rec(pos,true,groups))return true;a[pos]+=2}if(a[pos]>=3){a[pos]-=3;if(rec(pos,pair,groups+1))return true;a[pos]+=3}if(pos<27&&pos%9<=6&&a[pos+1]&&a[pos+2]){a[pos]--;a[pos+1]--;a[pos+2]--;if(rec(pos,pair,groups+1))return true;a[pos]++;a[pos+1]++;a[pos+2]++}return false}return rec(0,false,0)}
function isAgariLocal(c){return isKokushiLocal(c)||isChiitoiLocal(c)||isStdLocal(c)}
function updateSetupTimer(end){clearInterval(setupTimerHandle);const tick=()=>{const ms=Math.max(0,end-Date.now());const sec=Math.ceil(ms/1000);$('setupTimer').textContent=`⌛ ${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;if(ms<=0)clearInterval(setupTimerHandle)};tick();setupTimerHandle=setInterval(tick,250)}

function renderGame(s){
  show('game'); $('roomInGame').textContent='ROOM '+s.code; $('stakeGame').textContent=money(s.stake); $('mySeat').textContent=s.me.seat==='EAST'?'東':'西'; $('opponentName').textContent=s.opponent?.nickname||'상대'; $('opponentSeat').textContent=s.opponent?.seat==='EAST'?'東':'西'; $('opponentCount').textContent=`${s.opponent?.discardCount||0}/17`; setTileContent($('doraGame'),s.doraIndicator,'tile-mini');
  $('opponentRiichi').textContent=s.opponent?.isRiichi?'RIICHI':'-'; $('myRiichi').textContent=s.me.isRiichi?'RIICHI':'NO RIICHI'; $('myTenpai').textContent=s.me.isTenpai?'TENPAI':'NOTEN'; $('myFuriten').textContent=s.me.furiten?'FURITEN':''; $('discardProgress').textContent=`${s.me.discardCount}/17`;
  $('turnIndicator').textContent=s.turn===s.me.seat?'MY TURN':'OPPONENT TURN';
  const od=$('opponentDiscards'); od.innerHTML=''; (s.opponent?.discardedTiles||[]).forEach(t=>od.appendChild(renderTile(t)));
  const cand=$('candidates');cand.innerHTML='';sortTiles(s.me.discardCandidates||[]).forEach(t=>{const el=renderTile(t);el.onclick=()=>{if(s.turn!==s.me.seat)return toast('상대 턴입니다.');socket.emit('discard_tile',{tile:t})};cand.appendChild(el)});
  const hand=$('myHand');hand.innerHTML='';sortTiles(s.me.hand13||[]).forEach(t=>hand.appendChild(renderTile(t,'tile')));
  const ld=$('lastDiscard'); if(s.lastDiscard!=null){ld.classList.remove('hidden');setTileContent(ld,s.lastDiscard,'tile last-discard-tile')} else {ld.classList.add('hidden');ld.innerHTML=''}
  $('candidateCount').textContent=s.me.discardCandidates?.length??0;
  const ron=$('ronBtn');ron.disabled=!s.canRon;ron.title=s.ronReason||'';
}

function renderResult(s){
  show('result'); const r=s.result; $('resultMain').textContent=r?.type==='RON'?r.classification:'DRAW';
  if(r?.type==='RON'){
    const winnerName=r.winner===s.me.seat?s.me.nickname:(s.opponent?.nickname||'상대');
    const loserName=r.loser===s.me.seat?s.me.nickname:(s.opponent?.nickname||'상대');
    $('resultDetail').innerHTML=`<div class="result-burst"><b>${r.winner===s.me.seat?'YOU WIN':'YOU LOSE'}</b></div><div>${winnerName} 승 · ${loserName} 패</div><div class="payment-line">${loserName} → ${winnerName} <b>${money(r.payment)}</b></div><div>${r.han}판 ${r.fu? r.fu+'부':''}</div><div>기본 ${r.baseHan}판 · 도라 ${r.dora} · 우라도라 ${r.ura}</div>`;
    const yl=$('yakuList');yl.innerHTML='';(r.yaku||[]).forEach(y=>{const x=document.createElement('div');x.className='yaku';x.textContent=`${y[0]} ${y[1]}판`;yl.appendChild(x)});
  } else {$('resultDetail').innerHTML=`<div>양쪽 모두 17장까지 타패했습니다.</div><div>다음 판 판돈: <b>${money(r.nextStake)}</b></div>`;$('yakuList').innerHTML=''}
}

socket.on('room_created',({code})=>{show('lobby');$('roomCodeLobby').textContent=code;$('bigRoomCode').textContent=code});
socket.on('joined_room',({code})=>toast(`${code} 방에 참가했습니다.`));
socket.on('notice',msg=>toast(msg));
socket.on('dora_pool',({poolSize})=>{
  const box=$('doraPool');box.innerHTML='';for(let i=0;i<poolSize;i++){const b=document.createElement('button');b.className='dora-back';b.textContent=(i+1);b.onclick=()=>socket.emit('select_dora',{index:i});box.appendChild(b)}
});
socket.on('dora_selected',({dora})=>{ $('doraWait').classList.remove('hidden'); $('doraWait').innerHTML=''; $('doraWait').append('도라표시패: '); $('doraWait').appendChild(renderTile(dora,'tile-mini')); });
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
