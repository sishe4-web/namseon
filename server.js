const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3000);
const SETUP_MS = 3 * 60 * 1000;
const DRAW_LIMIT = 17;
const rooms = new Map();

const TILE_NAMES = [
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}m`),
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}p`),
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}s`),
  'E', 'S', 'W', 'N', 'P', 'F', 'C'
];
const TILE_LABELS = [
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}萬`),
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}筒`),
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}索`),
  '東', '南', '西', '北', '白', '發', '中'
];

function tileSuit(t) { return t < 9 ? 'm' : t < 18 ? 'p' : t < 27 ? 's' : 'z'; }
function isHonor(t) { return t >= 27; }
function isTerminal(t) { return t < 27 && (t % 9 === 0 || t % 9 === 8); }
function isSimple(t) { return t < 27 && !isTerminal(t); }
function isTerminalOrHonor(t) { return isTerminal(t) || isHonor(t); }
function tileLabel(t) { return TILE_LABELS[t]; }
function cloneCounts(counts) { return counts.slice(); }
function countsFromTiles(tiles) { const c = Array(34).fill(0); for (const t of tiles) c[t]++; return c; }
function tilesFromCounts(counts) { const a=[]; counts.forEach((n,t)=>{ for(let i=0;i<n;i++) a.push(t); }); return a; }
function shuffle(a) { for (let i=a.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function makeWall() { const a=[]; for(let t=0;t<34;t++) for(let i=0;i<4;i++) a.push(t); return shuffle(a); }
function id() { return crypto.randomBytes(5).toString('hex'); }
function roomCode() { let c; do { c = Math.random().toString(36).slice(2,8).toUpperCase(); } while(rooms.has(c)); return c; }
function playerSeat(room, socketId) {
  if (room.players.EAST?.id === socketId) return 'EAST';
  if (room.players.WEST?.id === socketId) return 'WEST';
  return null;
}
function otherSeat(seat) { return seat === 'EAST' ? 'WEST' : 'EAST'; }

// ----- Hand / agari engine -----
function isChiitoitsu(counts) {
  let pairs = 0;
  for (const n of counts) {
    if (n === 2) pairs++;
    else if (n !== 0) return false;
  }
  return pairs === 7;
}

function isKokushi(counts) {
  const yaos = [0,8,9,17,18,26,27,28,29,30,31,32,33];
  let pair = false;
  for (const t of yaos) {
    if (counts[t] === 0) return false;
    if (counts[t] >= 2) pair = true;
  }
  for (let t=0;t<34;t++) if (!yaos.includes(t) && counts[t] > 0) return false;
  return pair;
}

function standardDecompositions(counts) {
  const result = [];
  const c = cloneCounts(counts);
  const groups = [];
  function rec(pos=0, pairUsed=false) {
    while (pos < 34 && c[pos] === 0) pos++;
    if (pos === 34) {
      if (pairUsed && groups.length === 5) result.push(groups.map(g => ({...g})));
      return;
    }
    if (!pairUsed && c[pos] >= 2) {
      c[pos]-=2; groups.push({type:'pair', tiles:[pos,pos]}); rec(pos,true); groups.pop(); c[pos]+=2;
    }
    if (c[pos] >= 3) {
      c[pos]-=3; groups.push({type:'triplet', tiles:[pos,pos,pos]}); rec(pos,pairUsed); groups.pop(); c[pos]+=3;
    }
    if (pos < 27 && pos % 9 <= 6 && c[pos+1] > 0 && c[pos+2] > 0) {
      c[pos]--; c[pos+1]--; c[pos+2]--; groups.push({type:'sequence', tiles:[pos,pos+1,pos+2]}); rec(pos,pairUsed); groups.pop(); c[pos]++; c[pos+1]++; c[pos+2]++;
    }
  }
  rec();
  return result;
}

function isAgari14(counts) {
  return isKokushi(counts) || isChiitoitsu(counts) || standardDecompositions(counts).length > 0;
}

function getWaits(hand13) {
  const counts = countsFromTiles(hand13);
  const waits=[];
  for(let t=0;t<34;t++) {
    if (counts[t] >= 4) continue;
    counts[t]++;
    if (isAgari14(counts)) waits.push(t);
    counts[t]--;
  }
  return waits;
}

function doraFromIndicator(ind) {
  if (ind < 27) return ind < Math.floor(ind/9)*9+8 ? ind+1 : Math.floor(ind/9)*9;
  if (ind >= 27 && ind <= 30) return ind === 30 ? 27 : ind+1;
  if (ind === 31) return 32;
  if (ind === 32) return 33;
  return 31;
}

function findWinContext(decomp, winTile, winByRon=true) {
  const candidates=[];
  for (const g of decomp) {
    if (g.type === 'pair' && g.tiles[0] === winTile) candidates.push('tanki');
    if (g.type === 'sequence' && g.tiles.includes(winTile)) {
      const start = g.tiles[0];
      if ((start % 9 === 0 && winTile === start+2) || (start % 9 === 6 && winTile === start)) candidates.push('penchan');
      else if (winTile === start+1) candidates.push('kanchan');
      else candidates.push('ryanmen');
    }
    if (g.type === 'triplet' && g.tiles[0] === winTile) candidates.push(winByRon ? 'shanpon' : 'triplet');
  }
  return candidates;
}

function isValuePair(t, seat) {
  if (t >= 31) return true;
  if (t === (seat === 'EAST' ? 27 : 29)) return true;
  return false;
}

function groupsContainTerminalHonor(g) { return g.tiles.some(isTerminalOrHonor); }
function groupsAllTerminalHonor(g) { return g.tiles.every(isTerminalOrHonor); }

function detectYakuman(counts, decomps) {
  const y=[];
  if (isKokushi(counts)) y.push({name:'国士無双', han:13});
  const allHonors = counts.every((n,t)=>n===0||isHonor(t));
  const allTerminals = counts.every((n,t)=>n===0||isTerminal(t));
  const greenSet = new Set([19,20,22,23,25,32]);
  const allGreen = counts.every((n,t)=>n===0||greenSet.has(t));
  if (allHonors) y.push({name:'字一色',han:13});
  if (allTerminals) y.push({name:'清老頭',han:13});
  if (allGreen) y.push({name:'緑一色',han:13});
  const dragonTrip = [31,32,33].every(t=>counts[t] >= 3);
  if (dragonTrip) y.push({name:'大三元',han:13});
  const windTrip = [27,28,29,30].filter(t=>counts[t]>=3).length;
  if (windTrip === 4) y.push({name:'大四喜',han:26});
  else if (windTrip === 3 && [27,28,29,30].some(t=>counts[t]===2)) y.push({name:'小四喜',han:13});
  // Four concealed triplets. Ron is only valid on a pair wait.
  for (const d of decomps) {
    const trip = d.filter(g=>g.type==='triplet').length;
    if (trip===4) y.push({name:'四暗刻',han:13, requiresPairWait:true});
  }
  // Chuuren: one suit, 1112345678999 + one extra.
  for (const base of [0,9,18]) {
    const s=counts.slice(base,base+9);
    if (s.reduce((a,b)=>a+b,0)!==14) continue;
    const need=[3,1,1,1,1,1,1,1,3];
    if (need.every((n,i)=>s[i]>=n)) y.push({name:'九蓮宝燈',han:13});
  }
  return dedupeYakuman(y);
}
function dedupeYakuman(y) { const seen=new Set(); return y.filter(v=>{const key=v.name+v.requiresPairWait; if(seen.has(key)) return false; seen.add(key); return true;}); }

function calcFu(decomp, counts, winTile, seat, winByRon=true, pinfu=false, chiitoi=false) {
  if (chiitoi) return 25;
  if (pinfu && winByRon) return 30;
  let fu=20;
  for(const g of decomp) {
    if (g.type==='triplet') fu += isTerminalOrHonor(g.tiles[0]) ? 8 : 4;
    if (g.type==='pair' && isValuePair(g.tiles[0], seat)) fu += 2;
  }
  const waits=findWinContext(decomp,winTile,winByRon);
  if (waits.some(w=>w==='tanki'||w==='kanchan'||w==='penchan')) fu+=2;
  if (winByRon) fu=Math.max(fu,30);
  return Math.ceil(fu/10)*10;
}

function calcYakuForDecomp(decomp, counts, winTile, seat, context) {
  const y=[];
  if (context.riichi) y.push(['立直',1]);
  if (context.ippatsu) y.push(['一発',1]);
  if (context.houtei) y.push(['河底撈魚',1]);

  if (counts.every((n,t)=>n===0||isSimple(t))) y.push(['断么九',1]);

  const allSeq = decomp.filter(g=>g.type==='sequence');
  const triplets = decomp.filter(g=>g.type==='triplet');
  const pair = decomp.find(g=>g.type==='pair');

  const pinfu = allSeq.length===4 && pair && !isValuePair(pair.tiles[0],seat) && findWinContext(decomp,winTile,true).includes('ryanmen');
  if (pinfu) y.push(['平和',1]);

  const seqKeys=allSeq.map(g=>g.tiles.join(','));
  const iipei = seqKeys.some((v,i)=>seqKeys.indexOf(v)!==i);
  if (iipei) y.push(['一盃口',1]);

  const suitsPresent = new Set();
  let honor=false;
  for(let t=0;t<34;t++) if(counts[t]) { if(isHonor(t)) honor=true; else suitsPresent.add(tileSuit(t)); }
  if (suitsPresent.size===1) y.push(['清一色',6]);
  else if (suitsPresent.size===1 && honor) y.push(['混一色',3]);
  // unreachable due to size logic; fixed below by direct check
  if (suitsPresent.size===1 && honor) { const idx=y.findIndex(v=>v[0]==='清一色'); if(idx>=0)y.splice(idx,1); }

  const allGroupsTerminalHonor = decomp.every(g=>groupsContainTerminalHonor(g));
  const allGroupsTerminal = decomp.every(g=>g.tiles.every(isTerminal));
  const hasSeq=allSeq.length>0;
  if (allGroupsTerminalHonor && hasSeq) y.push(['混全帯么九',2]);
  if (allGroupsTerminal && hasSeq && !honor) y.push(['純全帯么九',3]);
  if (!hasSeq && counts.every((n,t)=>n===0||isTerminalOrHonor(t))) y.push(['混老頭',2]);
  if (!hasSeq) y.push(['対々和',2]);

  // Yakuhai: dragons + player's fixed seat wind (no round wind)
  for(const t of [31,32,33]) if(counts[t]>=3) y.push([`役牌 ${tileLabel(t)}`,1]);
  const seatWind = seat==='EAST' ? 27 : 29;
  if(counts[seatWind]>=3) y.push([`役牌 ${tileLabel(seatWind)}`,1]);

  // Ittsu
  for(const base of [0,9,18]) {
    const keys=new Set(seqKeys);
    if (keys.has(`${base},${base+1},${base+2}`)&&keys.has(`${base+3},${base+4},${base+5}`)&&keys.has(`${base+6},${base+7},${base+8}`)) y.push(['一気通貫',2]);
  }
  // Sanshoku doujun
  for(let start=0;start<=6;start++) {
    const target=[start,start+1,start+2];
    const ok=[0,9,18].every(base=>seqKeys.includes(target.map(x=>x+base).join(',')));
    if(ok)y.push(['三色同順',2]);
  }
  // Sanshoku doukou
  for(let r=0;r<9;r++) {
    if([0,9,18].every(base=>counts[base+r]>=3)) y.push(['三色同刻',2]);
  }
  // Shousangen
  const dragonTriplets=[31,32,33].filter(t=>counts[t]>=3).length;
  const dragonPairs=[31,32,33].filter(t=>counts[t]>=2).length;
  if(dragonTriplets===2 && dragonPairs===3) y.push(['小三元',2]);

  // Sanankou. A ron-completed triplet is not concealed for this purpose.
  let concealedTrip=0;
  for(const g of triplets) if(!(context.winByRon && g.tiles[0]===winTile)) concealedTrip++;
  if(concealedTrip>=3)y.push(['三暗刻',2]);

  // Chiitoitsu
  const chiitoi=isChiitoitsu(counts);
  if(chiitoi)y.push(['七対子',2]);

  return { yaku:y, pinfu, chiitoi };
}

function scoreHand(tiles14, winTile, seat, context) {
  const counts=countsFromTiles(tiles14);
  const yakuman=detectYakuman(counts, standardDecompositions(counts));
  if (yakuman.length) {
    let yCount=0;
    for(const y of yakuman) yCount += y.han/13;
    // Suuankou by ron is only valid on tanki.
    if (yakuman.some(y=>y.name==='四暗刻'&&y.requiresPairWait)) {
      const ds=standardDecompositions(counts);
      const tanki=ds.some(d=>findWinContext(d,winTile,true).includes('tanki'));
      if(!tanki) {
        // remove double-counted suuankou entries; other yakuman remain
        yCount -= yakuman.filter(y=>y.name==='四暗刻').reduce((a,b)=>a+b.han/13,0);
      }
    }
    if(yCount>0) return {yakumanCount:yCount, han:yCount*13, fu:0, yaku:yakuman.map(y=>[y.name,y.han])};
  }
  const ds=standardDecompositions(counts);
  if(!ds.length && !isChiitoitsu(counts)) return null;
  let best=null;
  for(const d of ds) {
    const calc=calcYakuForDecomp(d,counts,winTile,seat,context);
    const han=calc.yaku.reduce((s,v)=>s+v[1],0);
    const fu=calcFu(d,counts,winTile,seat,context.winByRon!==false,calc.pinfu,calc.chiitoi);
    const cand={han,fu,yaku:calc.yaku,decomp:d,chiitoi:false,pinfu:calc.pinfu};
    if(!best || han*1000+fu > best.han*1000+best.fu) best=cand;
  }
  if(isChiitoitsu(counts)) {
    const y=[['七対子',2],...context.riichi?[['立直',1]]:[],...context.ippatsu?[['一発',1]]:[],...context.houtei?[['河底撈魚',1]]:[]];
    const suits=new Set(); let hon=false; for(let t=0;t<34;t++)if(counts[t]){if(isHonor(t))hon=true;else suits.add(tileSuit(t));}
    if(suits.size===1 && hon)y.push(['混一色',3]);
    if(suits.size===1 && !hon)y.push(['清一色',6]);
    if(counts.every((n,t)=>n===0||isSimple(t)))y.push(['断么九',1]);
    const han=y.reduce((s,v)=>s+v[1],0);
    if(!best || han*1000+25 > best.han*1000+best.fu) best={han,fu:25,yaku:y,chiitoi:true,pinfu:false,decomp:null};
  }
  if(!best || best.han===0) return {...(best||{han:0,fu:20,yaku:[]}), yakumanCount:0};
  // Mangan classification uses pre-ura hand value.
  return {...best,yakumanCount:0};
}

function classifyScore(han, fu, yakumanCount) {
  if (yakumanCount && yakumanCount >= 1) return {label: yakumanCount===1?'役満':`${yakumanCount}倍役満`, payout: 4*yakumanCount};
  if (han >= 13) return {label:'数え役満', payout:4*Math.floor(han/13)};
  if (han >= 11) return {label:'三倍満', payout:3};
  if (han >= 8) return {label:'倍満', payout:2};
  if (han >= 6) return {label:'跳満', payout:1.5};
  if (han >= 5 || (han === 4 && fu >= 30) || (han === 3 && fu >= 60)) return {label:'満貫', payout:1};
  return {label:'満貫未満', payout:0};
}

function scoreBeforeUra(tiles14, winTile, seat, context) {
  const s=scoreHand(tiles14,winTile,seat,context);
  if(!s)return null;
  const cls=classifyScore(s.han,s.fu,s.yakumanCount);
  return {...s, classification:cls};
}

function countDora(tiles14, indicator) {
  if(indicator==null)return 0;
  const d=doraFromIndicator(indicator); return tiles14.filter(t=>t===d).length;
}

function evaluateRon(room, winnerSeat, winTile, discarderSeat) {
  const p=room.players[winnerSeat];
  if(!p) return {allowed:false,reason:'no player'};
  const context={
    riichi:true,
    ippatsu:p.ippatsu,
    houtei: discarderSeat==='WEST' && p.discardCount===17 && winnerSeat!=='WEST',
    winByRon:true
  };
  const tiles=p.hand13.concat([winTile]);
  const base=scoreBeforeUra(tiles,winTile,winnerSeat,context);
  if(!base || base.classification.payout===0) return {allowed:false,reason:'満貫条件未達',base};
  const ura=countDora(tiles,room.uraDoraIndicator);
  const finalHan=base.han+ura;
  const finalClass=classifyScore(finalHan,base.fu,base.yakumanCount);
  const dora=countDora(tiles,room.doraIndicator);
  const yaku=[...base.yaku];
  if(dora)yaku.push(['ドラ',dora]);
  if(ura)yaku.push(['裏ドラ',ura]);
  return {allowed:true,baseHan:base.han,han:finalHan,fu:base.fu,yaku,classification:finalClass,dora,ura};
}

function validatePlayerSetup(player) {
  const unique = new Set(player.hand13);
  if(player.hand13.length!==13)return {valid:false,tenpai:false,waits:[]};
  const counts=countsFromTiles(player.hand13);
  if(counts.some(n=>n>4))return {valid:false,tenpai:false,waits:[]};
  const waits=getWaits(player.hand13);
  return {valid:waits.length>0,tenpai:waits.length>0,waits};
}

function publicRoom(room, forSocketId) {
  const seat=playerSeat(room,forSocketId);
  const me=seat?room.players[seat]:null;
  const opp=seat?room.players[otherSeat(seat)]:null;
  return {
    code:room.code,
    phase:room.phase,
    dealer:room.dealer,
    stake:room.stake,
    roundNumber:room.roundNumber,
    doraIndicator:room.doraIndicator,
    setupEndsAt:room.setupEndsAt,
    turn:room.turn,
    lastDiscard:room.lastDiscard,
    lastDiscardBy:room.lastDiscardBy,
    winner:room.winner,
    result:room.result,
    me: me ? {
      id:me.id, nickname:me.nickname, seat:me.seat,
      private34Tiles:me.private34Tiles,
      hand13:me.hand13,
      discardCandidates:me.discardCandidates,
      discardedTiles:me.discardedTiles,
      discardCount:me.discardCount,
      setupConfirmed:me.setupConfirmed,
      isTenpai:me.isTenpai,
      isRiichi:me.isRiichi,
      ippatsu:me.ippatsu,
      waits:me.waits,
      furiten:me.furiten,
      temporaryFuriten:me.temporaryFuriten,
      setupTimedOut:me.setupTimedOut
    }:null,
    opponent: opp ? {
      id:opp.id, nickname:opp.nickname, seat:opp.seat,
      discardedTiles:opp.discardedTiles,
      discardCount:opp.discardCount,
      setupConfirmed:opp.setupConfirmed,
      isTenpai:opp.isTenpai,
      isRiichi:opp.isRiichi,
      ippatsu:opp.ippatsu
    }:null,
    canRon:false,
    ronReason:null,
    ronInfo:null
  };
}

function emitRoom(room) {
  for(const s of [room.players.EAST?.id,room.players.WEST?.id]) if(s) {
    const payload=publicRoom(room,s);
    const seat=playerSeat(room,s);
    const oppSeat=otherSeat(seat);
    if(room.phase==='PLAYING' && room.lastDiscard!=null && room.lastDiscardBy===oppSeat) {
      const p=room.players[seat];
      const wait = p.waits.includes(room.lastDiscard);
      const permanent = p.furiten;
      const evalResult = wait && !permanent && !p.temporaryFuriten ? evaluateRon(room,seat,room.lastDiscard,oppSeat):{allowed:false,reason:permanent?'후리텐':'일시 후리텐'};
      payload.canRon=!!evalResult.allowed;
      payload.ronReason=evalResult.reason||null;
      payload.ronInfo=evalResult.allowed?evalResult:null;
    }
    io.to(s).emit('state',payload);
  }
}

function initialPlayer(id, nickname, seat) {
  return {
    id,nickname,seat,private34Tiles:[],hand13:[],discardCandidates:[],discardedTiles:[],
    setupConfirmed:false,isTenpai:false,isRiichi:false,ippatsu:false,discardCount:0,waits:[],furiten:false,temporaryFuriten:false,setupTimedOut:false
  };
}

function startRound(room) {
  const wall=makeWall();
  room.phase='DORA_SELECT';
  room.witnessWall=wall.slice();
  room.players.EAST.private34Tiles=wall.slice(0,34);
  room.players.WEST.private34Tiles=wall.slice(34,68);
  room.doraPool=wall.slice(68);
  room.doraSelectionIndex=null;
  room.doraIndicator=null;
  room.uraDoraIndicator=null;
  room.lastDiscard=null; room.lastDiscardBy=null; room.turn=null; room.winner=null; room.result=null;
  room.players.EAST.hand13=[]; room.players.WEST.hand13=[];
  room.players.EAST.discardCandidates=[]; room.players.WEST.discardCandidates=[];
  room.players.EAST.discardedTiles=[]; room.players.WEST.discardedTiles=[];
  room.players.EAST.discardCount=0; room.players.WEST.discardCount=0;
  room.players.EAST.setupConfirmed=false; room.players.WEST.setupConfirmed=false;
  room.players.EAST.isRiichi=false; room.players.WEST.isRiichi=false;
  room.players.EAST.ippatsu=false; room.players.WEST.ippatsu=false;
  room.players.EAST.furiten=false; room.players.WEST.furiten=false;
  room.players.EAST.temporaryFuriten=false; room.players.WEST.temporaryFuriten=false;
  room.players.EAST.setupTimedOut=false; room.players.WEST.setupTimedOut=false;
  io.to(room.players.EAST.id).emit('dora_pool',{poolSize:room.doraPool.length});
  io.to(room.players.WEST.id).emit('dora_pool',{poolSize:room.doraPool.length});
  emitRoom(room);
}

function finishDoraSelection(room,index) {
  if(room.phase!=='DORA_SELECT') return;
  const i=Math.max(0,Math.min(room.doraPool.length-2,index|0));
  room.doraSelectionIndex=i;
  room.doraIndicator=room.doraPool[i];
  room.uraDoraIndicator=room.doraPool[i+1];
  room.phase='SETUP'; room.setupEndsAt=Date.now()+SETUP_MS;
  io.to(room.players.EAST.id).emit('dora_selected',{dora:room.doraIndicator});
  io.to(room.players.WEST.id).emit('dora_selected',{dora:room.doraIndicator});
  emitRoom(room);
}

function lockSetup(room, seat, hand13, forced=false) {
  const p=room.players[seat];
  if(room.phase!=='SETUP' || p.setupConfirmed) return;
  const counts=countsFromTiles(p.private34Tiles);
  const selected=[]; const used=new Set();
  for(const t of Array.isArray(hand13)?hand13:[]) {
    if(t>=0&&t<34&&!used.has(t) && selected.filter(x=>x===t).length<counts[t]) { selected.push(t); used.add(`${t}:${selected.filter(x=>x===t).length}`); }
  }
  // The browser sends the exact 13 tile list. Preserve it; fill if timed out.
  const haveCounts=countsFromTiles(selected);
  if(selected.length<13 && forced) {
    for(let t=0;t<34&&selected.length<13;t++) while(haveCounts[t]<counts[t]&&selected.length<13) { selected.push(t); haveCounts[t]++; }
  }
  if(selected.length!==13 && !forced) return;
  p.hand13=selected;
  const restCounts=countsFromTiles(p.private34Tiles);
  for(const t of selected) restCounts[t]--;
  p.discardCandidates=tilesFromCounts(restCounts);
  const val=validatePlayerSetup(p);
  p.isTenpai=val.tenpai;
  p.waits=val.waits;
  p.setupConfirmed=true;
  p.setupTimedOut=forced;
  // Every player makes a first-turn riichi declaration; noten is allowed and recorded.
  p.isRiichi=true;
  p.ippatsu=true;
  if(!p.waits.length) p.isTenpai=false;
  if(room.players.EAST.setupConfirmed && room.players.WEST.setupConfirmed) beginPlay(room);
  else emitRoom(room);
}

function beginPlay(room) {
  room.phase='PLAYING';
  room.turn=room.dealer;
  room.players.EAST.temporaryFuriten=false;
  room.players.WEST.temporaryFuriten=false;
  emitRoom(room);
}

function updateFuriten(player) {
  const own = new Set(player.discardedTiles);
  player.furiten = player.waits.some(t=>own.has(t));
}

function discard(room, seat, tile) {
  if(room.phase!=='PLAYING' || room.turn!==seat) return {ok:false,reason:'턴이 아닙니다.'};
  const p=room.players[seat];
  const idx=p.discardCandidates.indexOf(tile);
  if(idx<0)return {ok:false,reason:'유효하지 않은 타패입니다.'};
  p.discardCandidates.splice(idx,1);
  p.discardedTiles.push(tile);
  p.discardCount++;
  room.lastDiscard=tile; room.lastDiscardBy=seat;
  room.turn=otherSeat(seat);
  // Once a player gets their next turn, ippatsu has expired. Therefore the turn player remains in ippatsu only until then.
  p.temporaryFuriten=false;
  updateFuriten(p);
  // If opponent did not ron, ippatsu for both expires after the winner's next turn begins.
  const opp=room.players[otherSeat(seat)];
  // keep opp.ippatsu until their first own discard; handled below at turn start in next call.
  emitRoom(room);
  return {ok:true};
}

function prepareTurnState(room) {
  const p=room.players[room.turn];
  if(!p)return;
  if(p.discardCount>0) p.ippatsu=false;
  p.temporaryFuriten=false;
  emitRoom(room);
}

function doRon(room, winnerSeat) {
  if(room.phase!=='PLAYING') return {ok:false,reason:'현재 론을 선언할 수 없습니다.'};
  const discarder=otherSeat(winnerSeat);
  const tile=room.lastDiscard;
  if(room.lastDiscardBy!==discarder)return {ok:false,reason:'해당 패로 론할 수 없습니다.'};
  const p=room.players[winnerSeat];
  if(!p.waits.includes(tile))return {ok:false,reason:'오름패가 아닙니다.'};
  if(p.furiten)return {ok:false,reason:'후리텐입니다.'};
  if(p.temporaryFuriten)return {ok:false,reason:'일시 후리텐입니다.'};
  const evaluated=evaluateRon(room,winnerSeat,tile,discarder);
  if(!evaluated.allowed)return {ok:false,reason:evaluated.reason};
  room.phase='RESULT'; room.winner=winnerSeat;
  const payment=room.stake*evaluated.classification.payout;
  room.result={
    type:'RON',winner:winnerSeat,loser:discarder,tile,han:evaluated.han,fu:evaluated.fu,
    yaku:evaluated.yaku,classification:evaluated.classification.label,payment,
    baseHan:evaluated.baseHan,dora:evaluated.dora,ura:evaluated.ura
  };
  p.ippatsu=false; room.players[discarder].ippatsu=false;
  emitRoom(room);
  return {ok:true,result:room.result};
}

function doDraw(room) {
  if(room.phase!=='PLAYING') return;
  if(room.players.EAST.discardCount>=DRAW_LIMIT && room.players.WEST.discardCount>=DRAW_LIMIT) {
    room.phase='DRAW';
    room.stake*=2;
    room.result={type:'DRAW',message:'17장씩 타패했지만 화료가 없어 유국',nextStake:room.stake};
    room.dealer=otherSeat(room.dealer);
    emitRoom(room);
  }
}

io.on('connection', socket=>{
  socket.on('create_room', ({nickname,stake})=>{
    const code=roomCode();
    const room={code,stake:Number(stake)||1000000,players:{EAST:initialPlayer(socket.id,String(nickname||'Player 1').slice(0,20),'EAST'),WEST:null},dealer:'EAST',roundNumber:1,phase:'WAITING',setupEndsAt:null,turn:null,lastDiscard:null,lastDiscardBy:null,winner:null,result:null,doraIndicator:null,uraDoraIndicator:null,doraPool:[]};
    rooms.set(code,room); socket.join(code); socket.data.roomCode=code;
    socket.emit('room_created',{code}); emitRoom(room);
  });

  socket.on('join_room', ({code,nickname})=>{
    const room=rooms.get(String(code||'').toUpperCase());
    if(!room)return socket.emit('error_message','방을 찾을 수 없습니다.');
    if(room.players.WEST && room.players.EAST?.id!==socket.id)return socket.emit('error_message','방이 가득 찼습니다.');
    if(room.players.EAST.id===socket.id)return;
    room.players.WEST=initialPlayer(socket.id,String(nickname||'Player 2').slice(0,20),'WEST');
    socket.join(room.code); socket.data.roomCode=room.code;
    socket.emit('joined_room',{code:room.code});
    io.to(room.code).emit('notice','두 플레이어가 입장했습니다. 게임을 시작합니다.');
    startRound(room);
  });

  socket.on('select_dora',({index})=>{
    const room=rooms.get(socket.data.roomCode); if(!room)return;
    if(playerSeat(room,socket.id)!=='EAST')return socket.emit('error_message','선만 도라표시패를 선택할 수 있습니다.');
    finishDoraSelection(room,index);
  });

  socket.on('confirm_hand',({tiles})=>{
    const room=rooms.get(socket.data.roomCode); if(!room)return;
    const seat=playerSeat(room,socket.id); if(!seat)return;
    if(room.phase!=='SETUP')return;
    if(Date.now()>room.setupEndsAt) return lockSetup(room,seat,tiles,true);
    lockSetup(room,seat,tiles,false);
  });

  socket.on('discard_tile',({tile})=>{
    const room=rooms.get(socket.data.roomCode); if(!room)return;
    const seat=playerSeat(room,socket.id); if(!seat)return;
    const r=discard(room,seat,Number(tile)); if(!r.ok)socket.emit('error_message',r.reason);
    doDraw(room);
  });

  socket.on('declare_ron',()=>{
    const room=rooms.get(socket.data.roomCode); if(!room)return;
    const seat=playerSeat(room,socket.id); if(!seat)return;
    const r=doRon(room,seat); if(!r.ok)socket.emit('error_message',r.reason);
  });

  socket.on('pass_ron',()=>{
    const room=rooms.get(socket.data.roomCode); if(!room)return;
    const seat=playerSeat(room,socket.id); if(!seat)return;
    const p=room.players[seat];
    if(room.phase==='PLAYING' && room.lastDiscard!=null && room.lastDiscardBy===otherSeat(seat)) {
      if(p.waits.includes(room.lastDiscard) && !p.furiten) p.temporaryFuriten=true;
    }
    emitRoom(room);
  });

  socket.on('next_round',()=>{
    const room=rooms.get(socket.data.roomCode); if(!room)return;
    if(room.phase!=='RESULT' && room.phase!=='DRAW')return;
    room.roundNumber++;
    startRound(room);
  });

  socket.on('disconnect',()=>{
    const code=socket.data.roomCode; if(!code)return;
    const room=rooms.get(code); if(!room)return;
    const seat=playerSeat(room,socket.id);
    if(seat){ room.phase='WAITING'; room.players[seat]=null; }
    if(!room.players.EAST && !room.players.WEST)rooms.delete(code);
    else emitRoom(room);
  });
});

setInterval(()=>{
  const now=Date.now();
  for(const room of rooms.values()){
    if(room.phase==='SETUP' && room.setupEndsAt && now>=room.setupEndsAt){
      for(const seat of ['EAST','WEST']){
        const p=room.players[seat];
        if(p && !p.setupConfirmed) lockSetup(room,seat,p.hand13,true);
      }
    }
    if(room.phase==='PLAYING' && room.players.EAST?.discardCount>=DRAW_LIMIT && room.players.WEST?.discardCount>=DRAW_LIMIT) doDraw(room);
  }
},250);

server.listen(PORT,()=>console.log(`17bo server running at http://localhost:${PORT}`));
