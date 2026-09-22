const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public'), {
  etag:false,
  maxAge:0,
  setHeaders(res){ res.setHeader('Cache-Control','no-store'); }
}));

const PORT = Number(process.env.PORT || 3000);
const SETUP_MS = 3 * 60 * 1000;
const TURN_MS = 60 * 1000;
const DORA_REVEAL_MS = 3200;
const CHARACTER_DRAW_REVEAL_MS = 3000;
const RON_REVEAL_MS = 2200;
const DRAW_LIMIT = 17;
const rooms = new Map();
const CHARACTERS = {
  KAIJI: {name:'이토 카이지', ability:'원하는 특수 론패 2장'},
  MURAOKA: {name:'무라오카 타카시', ability:'상대 패산의 무작위 8종류와 각 보유 매수 공개'},
  WASHIZU: {name:'와시즈 이와오', ability:'9순까지 요구패 타패 금지'},
  AKAGI: {name:'아카기 시게루', ability:'절일문'}
};
const CHARACTER_ORDER = ['KAIJI','MURAOKA','WASHIZU','AKAGI'];

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
function sortTiles(tiles) { return [...tiles].sort((a,b)=>a-b); }
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
function characterName(key) { return CHARACTERS[key]?.name || key || ''; }
function randomRevealCounts(tiles, typeCount=8) {
  const counts=countsFromTiles(tiles);
  const available=[];
  for(let t=0;t<34;t++) if(counts[t]>0) available.push(t);
  const chosen=shuffle(available).slice(0,Math.min(typeCount,available.length));
  return chosen.map(t=>({tile:t,count:counts[t]})).sort((a,b)=>a.tile-b.tile);
}
function isForbiddenByWashizu(room, seat, tile) {
  const source=room.players[otherSeat(seat)];
  return source?.character==='WASHIZU' && room.players[seat].discardCount < 9 && isTerminalOrHonor(tile);
}
function isForbiddenByAkagi(room, seat, tile) {
  const source=room.players[otherSeat(seat)];
  if(source?.character!=='AKAGI' || source.akagiSuit==null) return false;
  return tileSuit(tile)===source.akagiSuit && room.players[seat].discardCandidates.some(t=>tileSuit(t)!==source.akagiSuit);
}
function canDiscardTile(room, seat, tile) {
  const p=room.players[seat];
  if(!p || !p.discardCandidates.includes(tile)) return {ok:false,reason:'유효하지 않은 타패입니다.'};
  if(isForbiddenByWashizu(room,seat,tile)) return {ok:false,reason:'와시즈의 위압감으로 9순까지 요구패를 버릴 수 없습니다.'};
  if(isForbiddenByAkagi(room,seat,tile)) return {ok:false,reason:'아카기의 절일문으로 이 수패를 버릴 수 없습니다.'};
  return {ok:true};
}


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

function isKokushi13Wait(counts, winTile) {
  const yaos = [0,8,9,17,18,26,27,28,29,30,31,32,33];
  // Before the winning tile, all 13 terminal/honor types must be present exactly once.
  return yaos.every(t => counts[t] === (t === winTile ? 2 : 1)) &&
    counts.every((n,t) => yaos.includes(t) ? n >= 1 : n === 0) &&
    yaos.includes(winTile);
}

function detectYakuman(counts, decomps, winTile=null) {
  const y=[];
  if (isKokushi(counts)) y.push({name:'国士無双',han:(winTile!=null && isKokushi13Wait(counts,winTile))?26:13});
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
    if (need.every((n,i)=>s[i]>=n)) {
      const extra = s.map((n,i)=>n-need[i]);
      const extraCount=extra.reduce((a,b)=>a+b,0);
      const pure = winTile!=null && extraCount===1 && extra[winTile-base]===1 &&
        counts.every((n,t)=>t>=base&&t<base+9 ? true : n===0);
      y.push({name:'九蓮宝燈',han:pure?26:13});
    }
  }
  return dedupeYakuman(y);
}
function dedupeYakuman(y) {
  const seen=new Set();
  return y.filter(v=>{const key=`${v.name}:${v.han}`; if(seen.has(key)) return false; seen.add(key); return true;});
}

function waitTypeForGroup(g, winTile) {
  if (!g.tiles.includes(winTile)) return null;
  if (g.type==='pair') return 'tanki';
  if (g.type==='triplet') return 'shanpon';
  if (g.type==='sequence') {
    const start=g.tiles[0];
    if ((start%9===0 && winTile===start+2) || (start%9===6 && winTile===start)) return 'penchan';
    if (winTile===start+1) return 'kanchan';
    return 'ryanmen';
  }
  return null;
}

function calcFu(decomp, counts, winTile, seat, winByRon=true, pinfu=false, chiitoi=false) {
  if (chiitoi) return 25;
  if (pinfu && winByRon) return 30;

  // Enumerate every legal group that can contain the winning tile and take the
  // highest-fu interpretation. All hands are closed in this game; only a
  // triplet completed by ron is treated as open for fu purposes.
  const assignments=[];
  decomp.forEach((g,i)=>{ if(g.tiles.includes(winTile)) assignments.push(i); });
  if(!assignments.length) assignments.push(-1);
  let best=0;
  for(const winGroupIndex of assignments) {
    let fu=20 + (winByRon ? 10 : 0);
    decomp.forEach((g,i)=>{
      if(g.type==='pair' && isValuePair(g.tiles[0],seat)) fu+=2;
      if(g.type==='triplet') {
        const terminalHonor=isTerminalOrHonor(g.tiles[0]);
        const openedByRon=winByRon && i===winGroupIndex;
        fu += openedByRon ? (terminalHonor?4:2) : (terminalHonor?8:4);
      }
    });
    const wt=winGroupIndex>=0 ? waitTypeForGroup(decomp[winGroupIndex],winTile) : null;
    if(wt==='tanki'||wt==='kanchan'||wt==='penchan') fu+=2;
    fu=Math.ceil(fu/10)*10;
    if(fu>best) best=fu;
  }
  return Math.max(best,30);
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
  const seqFreq=new Map();
  for(const k of seqKeys) seqFreq.set(k,(seqFreq.get(k)||0)+1);
  const pairSeqCount=[...seqFreq.values()].filter(n=>n>=2).length;
  const ryanpeko = allSeq.length===4 && pairSeqCount===2;
  const iipei = !ryanpeko && pairSeqCount>=1;
  if (ryanpeko) y.push(['二盃口',3]);
  else if (iipei) y.push(['一盃口',1]);

  const suitsPresent = new Set();
  let honor=false;
  for(let t=0;t<34;t++) if(counts[t]) { if(isHonor(t)) honor=true; else suitsPresent.add(tileSuit(t)); }
  // One numbered suit only: honitsu (with honors) or chinitsu (without honors).
  if (suitsPresent.size===1 && honor) y.push(['混一色',3]);
  else if (suitsPresent.size===1 && !honor) y.push(['清一色',6]);

  const allGroupsHaveTerminal = decomp.every(g=>g.tiles.some(isTerminal));
  const allGroupsHaveTerminalOrHonor = decomp.every(g=>g.tiles.some(isTerminalOrHonor));
  const hasSeq=allSeq.length>0;
  // Junchan: every group/pair contains a terminal, no honors, and at least one sequence.
  // Chanta: every group/pair contains a terminal or honor, with at least one sequence.
  if (allGroupsHaveTerminal && hasSeq && !honor) y.push(['純全帯么九',3]);
  else if (allGroupsHaveTerminalOrHonor && hasSeq) y.push(['混全帯么九',2]);
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

  // Sanankou. If the ron tile can legally belong to another group, choose that
  // interpretation; only a triplet that must be completed by ron becomes open.
  const winCanBeOutsideTriplet=decomp.some(g=>g.type!=='triplet' && g.tiles.includes(winTile));
  let concealedTrip=triplets.length;
  if(context.winByRon && !winCanBeOutsideTriplet && triplets.some(g=>g.tiles[0]===winTile)) concealedTrip--;
  if(concealedTrip>=3)y.push(['三暗刻',2]);

  return { yaku:y, pinfu, chiitoi:false };
}

function scoreHand(tiles14, winTile, seat, context) {
  const counts=countsFromTiles(tiles14);
  let yakuman=detectYakuman(counts, standardDecompositions(counts), winTile);
  if (yakuman.length) {
    // Suuankou by ron is valid only when the winning tile completes the pair (tanki).
    if (yakuman.some(y=>y.name==='四暗刻'&&y.requiresPairWait)) {
      const ds=standardDecompositions(counts);
      const tanki=ds.some(d=>findWinContext(d,winTile,true).includes('tanki'));
      if(!tanki) yakuman=yakuman.filter(y=>y.name!=='四暗刻');
    }
    const yCount=yakuman.reduce((sum,y)=>sum+y.han/13,0);
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
    if(counts.every((n,t)=>n===0||isTerminalOrHonor(t)))y.push(['混老頭',2]);
    const han=y.reduce((s,v)=>s+v[1],0);
    if(!best || han*1000+25 > best.han*1000+best.fu) best={han,fu:25,yaku:y,chiitoi:true,pinfu:false,decomp:null};
  }
  if(!best || best.han===0) return {...(best||{han:0,fu:20,yaku:[]}), yakumanCount:0};
  // Mangan classification uses pre-ura hand value.
  return {...best,yakumanCount:0};
}

function classifyScore(han, fu, yakumanCount) {
  if (yakumanCount && yakumanCount >= 1) return {label: yakumanCount===1?'役満':`${yakumanCount}倍役満`, payout: 4*yakumanCount};
  if (han >= 13) return {label:'数え役満', payout:4};
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
  if(p.character==='KAIJI' && p.specialRonTiles.includes(winTile) && !p.waits.includes(winTile)) {
    return {allowed:true,special:'KAIJI',baseHan:5,han:5,fu:30,yaku:[['カイジ特수능력',5]],dora:0,ura:0,classification:{label:'満貫',payout:1}};
  }
  const context={
    riichi:true,
    ippatsu:p.ippatsu,
    houtei: discarderSeat==='WEST' && room.players.WEST?.discardCount===17,
    winByRon:true
  };
  const tiles=p.hand13.concat([winTile]);
  const base=scoreBeforeUra(tiles,winTile,winnerSeat,context);
  if(!base) return {allowed:false,reason:'역이 없습니다.',base};

  // Normal dora counts toward the initial mangan check. Ura-dora does not.
  // This is recalculated on every discard so late-discard yaku such as houtei
  // can make a 3 han 30 fu hand eligible via kiriage mangan.
  const dora=countDora(tiles,room.doraIndicator);
  const qualifyingHan=base.han+dora;
  const qualifyingClass=classifyScore(qualifyingHan,base.fu,base.yakumanCount);
  if(qualifyingClass.payout===0) return {allowed:false,reason:'만관 조건 미달',baseHan:base.han,fu:base.fu,dora,classification:qualifyingClass};

  const ura=countDora(tiles,room.uraDoraIndicator);
  const finalHan=qualifyingHan+ura;
  const finalClass=classifyScore(finalHan,base.fu,base.yakumanCount);
  const yaku=[...base.yaku];
  if(dora)yaku.push(['ドラ',dora]);
  if(ura)yaku.push(['裏ドラ',ura]);
  return {allowed:true,baseHan:base.han,han:finalHan,fu:base.fu,yaku,classification:finalClass,dora,ura};
}

function buildWaitPreview(room, seat, hand13) {
  const counts=countsFromTiles(hand13||[]);
  if(!Array.isArray(hand13) || hand13.length!==13 || counts.some(n=>n>4)) return [];
  const waits=getWaits(hand13);
  return waits.map(t=>{
    const tiles=hand13.concat([t]);
    const base=scoreBeforeUra(tiles,t,seat,{riichi:true,ippatsu:false,houtei:false,winByRon:true});
    if(!base) return {tile:t,han:0,fu:0,yaku:[],classification:'역 없음',allowed:false};
    const dora=countDora(tiles,room.doraIndicator);
    const han=base.yakumanCount ? base.han : base.han+dora;
    const yaku=[...base.yaku];
    if(dora && !base.yakumanCount) yaku.push(['ドラ',dora]);
    const classification=classifyScore(han,base.fu,base.yakumanCount);
    return {tile:t,han,fu:base.fu,yaku,classification:classification.label,allowed:classification.payout>0};
  });
}

function validatePlayerSetup(player) {
  const unique = new Set(player.hand13);
  if(player.hand13.length!==13)return {valid:false,tenpai:false,waits:[]};
  const counts=countsFromTiles(player.hand13);
  if(counts.some(n=>n>4))return {valid:false,tenpai:false,waits:[]};
  const waits=getWaits(player.hand13);
  return {valid:waits.length>0,tenpai:waits.length>0,waits};
}

function waitRemaining(room, player, tile) {
  const own = (player.hand13 || []).filter(t=>t===tile).length;
  const dora = room.doraIndicator===tile ? 1 : 0;
  return Math.max(0, 4 - own - dora);
}

function publicRoom(room, forSocketId) {
  const seat=playerSeat(room,forSocketId);
  const me=seat?room.players[seat]:null;
  const opp=seat?room.players[otherSeat(seat)]:null;
  return {
    code:room.code,
    gameMode:room.gameMode,
    phase:room.phase,
    dealer:room.dealer,
    stake:room.stake,
    roundNumber:room.roundNumber,
    doraIndicator:room.doraIndicator,
    doraTile:room.doraIndicator==null?null:doraFromIndicator(room.doraIndicator),
    setupEndsAt:room.setupEndsAt,
    doraRevealEndsAt:room.doraRevealEndsAt||null,
    turnEndsAt:room.turnEndsAt||null,
    ronRevealEndsAt:room.ronRevealEndsAt||null,
    ronBlockEndsAt:room.ronBlockEndsAt||null,
    turn:room.turn,
    lastDiscard:room.lastDiscard,
    lastDiscardBy:room.lastDiscardBy,
    winner:room.winner,
    result:room.result,
    nextReady:room.nextReady || {EAST:false,WEST:false},
    nextReadyCount:Object.values(room.nextReady || {}).filter(Boolean).length,
    setupUnlock:room.setupUnlock||{EAST:false,WEST:false},
    pendingRon:room.pendingRon ? {winner:room.pendingRon.winner, tile:room.pendingRon.tile, endsAt:room.pendingRon.endsAt} : null,
    characterChoices:{EAST:room.players.EAST?.character||null,WEST:room.players.WEST?.character||null},
    characterPicker:room.characterPicker||null,
    characterDraw:{
      choices:{EAST:room.characterDrawChoices?.EAST ?? null,WEST:room.characterDrawChoices?.WEST ?? null},
      revealed:!!room.characterDrawRevealed,
      values:room.characterDrawRevealed && room.characterDrawValues ? room.characterDrawValues.slice() : null,
      picker:room.characterPicker||null
    },
    me: me ? {
      id:me.id, nickname:me.nickname, seat:me.seat,
      character:me.character, characterName:characterName(me.character), characterAbility:me.character ? (CHARACTERS[me.character]?.ability||'') : '',
      specialRonTiles:(me.specialRonTiles||[]).slice(),
      akagiSuit:me.akagiSuit,
      abilityReady:!!me.abilityReady,
      murauokaReveal:me.character==='MURAOKA' ? (me.murauokaReveal||[]) : [],
      private34Tiles:sortTiles(me.private34Tiles),
      hand13:sortTiles(me.hand13),
      discardCandidates:sortTiles(me.discardCandidates),
      discardedTiles:me.discardedTiles.slice(),
      discardCount:me.discardCount,
      setupConfirmed:me.setupConfirmed,
      isTenpai:me.isTenpai,
      isRiichi:me.isRiichi,
      ippatsu:me.ippatsu,
      waits:me.waits.slice(),
      waitRemaining:Object.fromEntries((me.waits||[]).map(t=>[t,waitRemaining(room,me,t)])),
      waitPreview:buildWaitPreview(room,seat,me.hand13),
      riichiDiscardIndex:me.riichiDiscardIndex,
      money:me.money,
      opponentMoney:opp?.money||0,
      nextReady:!!(room.nextReady?.[seat]),
      furiten:me.furiten,
      temporaryFuriten:me.temporaryFuriten,
      setupTimedOut:me.setupTimedOut
    }:null,
    opponent: opp ? {
      id:opp.id, nickname:opp.nickname, seat:opp.seat,
      character:opp.character, characterName:characterName(opp.character), characterAbility:opp.character ? (CHARACTERS[opp.character]?.ability||'') : '',
      discardedTiles:opp.discardedTiles.slice(),
      discardCount:opp.discardCount,
      riichiDiscardIndex:opp.riichiDiscardIndex,
      money:opp.money,
      nextReady:!!(room.nextReady?.[otherSeat(seat)]),
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
      const specialWait = p.character==='KAIJI' && p.specialRonTiles.includes(room.lastDiscard) && !wait;
      const permanent = p.furiten;
      let evalResult = {allowed:false,reason:permanent?'후리텐':'일시 후리텐'};
      if((wait || specialWait) && !permanent && !p.temporaryFuriten) evalResult=evaluateRon(room,seat,room.lastDiscard,oppSeat);
      // In this no-draw variant, if a winning tile is discarded but the hand is
      // only a yasume (below mangan), the player necessarily passes on it.
      // Treat that missed ron as minogashi/temporary furiten for the rest of the hand.
      if(wait && !permanent && !p.temporaryFuriten && !evalResult.allowed && evalResult.reason==='만관 조건 미달') {
        p.temporaryFuriten=true;
        evalResult={allowed:false,reason:'미노가시 후리텐'};
      }
      if(evalResult.allowed && !room.ronBlockEndsAt) room.ronBlockEndsAt=Date.now()+2000;
      payload.ronBlockEndsAt=room.ronBlockEndsAt||null;
      payload.canRon=!!evalResult.allowed;
      payload.ronReason=evalResult.reason ? (evalResult.allowed ? evalResult.reason : evalResult.reason) : null;
      payload.ronInfo=evalResult.allowed?evalResult:null;
    }
    io.to(s).emit('state',payload);
  }
}

function initialPlayer(id, nickname, seat) {
  return {
    id,nickname,seat,private34Tiles:[],hand13:[],discardCandidates:[],discardedTiles:[],
    setupConfirmed:false,isTenpai:false,isRiichi:false,ippatsu:false,discardCount:0,riichiDiscardIndex:null,waits:[],furiten:false,money:0,temporaryFuriten:false,setupTimedOut:false,
    character:null,specialRonTiles:[],akagiSuit:null,abilityReady:false,murauokaReveal:[],turnEndsAt:null
  };
}

function startRound(room) {
  room.dealer='EAST';
  const wall=makeWall();
  room.phase=room.gameMode==='CHARACTER' && !room.charactersLocked ? 'CHARACTER_DRAW' : 'DORA_REVEAL';
  room.characterDrawValues=null;
  room.characterDrawChoices={EAST:null,WEST:null};
  room.characterDrawRevealed=false;
  room.characterPicker=null;
  room.witnessWall=wall.slice();
  room.players.EAST.private34Tiles=wall.slice(0,34);
  room.players.WEST.private34Tiles=wall.slice(34,68);
  room.doraPool=wall.slice(68);
  room.doraSelectionIndex=null;
  room.doraIndicator=null;
  room.uraDoraIndicator=null;
  room.lastDiscard=null; room.lastDiscardBy=null; room.turn=null; room.winner=null; room.result=null; room.resultEndsAt=null;
  room.nextReady={EAST:false,WEST:false};
  room.setupUnlock={EAST:false,WEST:false};
  room.turnEndsAt=null;
  room.ronRevealEndsAt=null;
  room.ronBlockEndsAt=null;
  room.pendingRon=null;
  room.players.EAST.specialRonTiles=[]; room.players.WEST.specialRonTiles=[];
  room.players.EAST.akagiSuit=null; room.players.WEST.akagiSuit=null;
  room.players.EAST.abilityReady=false; room.players.WEST.abilityReady=false;
  room.players.EAST.murauokaReveal=[]; room.players.WEST.murauokaReveal=[];
  room.players.EAST.hand13=[]; room.players.WEST.hand13=[];
  room.players.EAST.discardCandidates=[]; room.players.WEST.discardCandidates=[];
  room.players.EAST.discardedTiles=[]; room.players.WEST.discardedTiles=[];
  room.players.EAST.discardCount=0; room.players.WEST.discardCount=0;
  room.players.EAST.riichiDiscardIndex=null; room.players.WEST.riichiDiscardIndex=null;
  room.players.EAST.setupConfirmed=false; room.players.WEST.setupConfirmed=false;
  room.players.EAST.isRiichi=false; room.players.WEST.isRiichi=false;
  room.players.EAST.ippatsu=false; room.players.WEST.ippatsu=false;
  room.players.EAST.furiten=false; room.players.WEST.furiten=false;
  room.players.EAST.temporaryFuriten=false; room.players.WEST.temporaryFuriten=false;
  room.players.EAST.setupTimedOut=false; room.players.WEST.setupTimedOut=false;
  io.to(room.players.EAST.id).emit('dora_pool',{poolSize:0});
  io.to(room.players.WEST.id).emit('dora_pool',{poolSize:0});
  if(room.phase==='DORA_REVEAL') beginDoraReveal(room);
  else if(room.phase==='CHARACTER_DRAW') beginCharacterDraw(room);
  else emitRoom(room);
}

function beginCharacterDraw(room) {
  room.phase='CHARACTER_DRAW';
  room.characterDrawValues=shuffle([0,1,2,3,4,5,6,7,8]);
  room.characterDrawChoices={EAST:null,WEST:null};
  room.characterDrawRevealed=false;
  room.characterPicker=null;
  emitRoom(room);
}

function resolveCharacterDraw(room) {
  if(room.phase!=='CHARACTER_DRAW' || room.characterDrawChoices.EAST==null || room.characterDrawChoices.WEST==null) return;
  room.characterDrawRevealed=true;
  const e=room.characterDrawValues[room.characterDrawChoices.EAST];
  const w=room.characterDrawValues[room.characterDrawChoices.WEST];
  if(e===w) room.characterPicker=null;
  else room.characterPicker=e>w?'EAST':'WEST';
  emitRoom(room);
  setTimeout(()=>{
    if(room.phase!=='CHARACTER_DRAW') return;
    if(e===w){ beginCharacterDraw(room); return; }
    room.phase='CHARACTER_SELECT';
    room.charactersLocked=false;
    emitRoom(room);
  }, CHARACTER_DRAW_REVEAL_MS);
}

function finishCharacterSelection(room, seat, character) {
  if(room.phase!=='CHARACTER_SELECT') return;
  if(room.characterPicker && room.characterPicker!==seat) return;
  if(!CHARACTERS[character]) return;
  if(room.players[seat]?.character) return;
  const other=room.players[otherSeat(seat)];
  if(other?.character===character) return;
  room.players[seat].character=character;
  if(room.players.EAST?.character && room.players.WEST?.character) {
    room.charactersLocked=true;
    room.phase='DORA_REVEAL';
    room.players.EAST.abilityReady=false; room.players.WEST.abilityReady=false;
    beginDoraReveal(room);
  } else {
    room.characterPicker=otherSeat(seat);
    emitRoom(room);
  }
}

function beginDoraReveal(room) {
  if(room.phase!=='DORA_REVEAL') return;
  const max=room.doraPool.length-2;
  const i=Math.floor(Math.random()*Math.max(1,max+1));
  room.doraSelectionIndex=Math.max(0,Math.min(max,i));
  room.doraIndicator=room.doraPool[room.doraSelectionIndex];
  room.uraDoraIndicator=room.doraPool[room.doraSelectionIndex+1];
  room.doraRevealEndsAt=Date.now()+DORA_REVEAL_MS;
  const endsAt=room.doraRevealEndsAt;
  io.to(room.players.EAST.id).emit('dora_reveal',{dora:room.doraIndicator,endsAt});
  io.to(room.players.WEST.id).emit('dora_reveal',{dora:room.doraIndicator,endsAt});
  emitRoom(room);
  setTimeout(()=>{
    if(room.phase==='DORA_REVEAL' && room.doraRevealEndsAt===endsAt) finishDoraReveal(room);
  }, DORA_REVEAL_MS+100);
}

function finishDoraReveal(room) {
  if(room.phase!=='DORA_REVEAL') return;
  room.phase='SETUP';
  room.setupEndsAt=Date.now()+SETUP_MS;
  room.doraRevealEndsAt=null;
  for(const seat of ['EAST','WEST']) {
    const p=room.players[seat];
    const opp=room.players[otherSeat(seat)];
    p.murauokaReveal = p.character==='MURAOKA' ? randomRevealCounts(opp.private34Tiles,8) : [];
  }
  emitRoom(room);
}

function finishDoraSelection(room,index) {
  // Legacy client compatibility: the server no longer lets the dealer pick.
  beginDoraReveal(room);
}

function lockSetup(room, seat, hand13, forced=false) {
  const p=room.players[seat];
  if(room.phase!=='SETUP' || p.setupConfirmed) return {ok:false,reason:p?.setupConfirmed?'이미 확정된 패입니다.':'조패 라운드가 아닙니다.'};
  const timedOut = p.setupTimedOut || (room.setupEndsAt && Date.now() > room.setupEndsAt);
  const counts=countsFromTiles(p.private34Tiles);
  const selected=[]; const used=new Set();
  for(const t of Array.isArray(hand13)?hand13:[]) {
    if(t>=0&&t<34&&!used.has(t) && selected.filter(x=>x===t).length<counts[t]) { selected.push(t); used.add(`${t}:${selected.filter(x=>x===t).length}`); }
  }
  // Even after the 3-minute limit, the player still has to choose exactly 13 tiles.
  if(selected.length!==13) return {ok:false,reason:`정확히 13장을 선택해야 합니다. 현재 ${selected.length}장입니다.`};
  if(p.character==='KAIJI') {
    const special=[...new Set((p.specialRonTiles||[]).map(Number).filter(t=>Number.isInteger(t)&&t>=0&&t<34))];
    if(special.length!==2) return {ok:false,reason:'카이지 특수 론패를 2장 선택해야 합니다.'};
    const naturalWaits=getWaits(selected);
    if(special.some(t=>naturalWaits.includes(t))) return {ok:false,reason:'현재 대기패는 카이지 특수 론패로 선택할 수 없습니다.'};
    p.specialRonTiles=special;
  }
  if(p.character==='AKAGI' && !['m','p','s'].includes(p.akagiSuit)) return {ok:false,reason:'아카기의 절일문 수패를 선택하세요.'};
  p.hand13=selected;
  const restCounts=countsFromTiles(p.private34Tiles);
  for(const t of selected) restCounts[t]--;
  p.discardCandidates=tilesFromCounts(restCounts);
  const val=validatePlayerSetup(p);
  p.isTenpai=timedOut ? false : val.tenpai;
  p.waits=timedOut ? [] : val.waits;
  p.setupConfirmed=true;
  p.setupTimedOut=!!timedOut;
  p.abilityReady=true;
  // Every player makes a first-turn riichi declaration; noten is allowed and recorded.
  p.isRiichi=true;
  p.ippatsu=true;
  if(!p.waits.length) p.isTenpai=false;
  if(room.players.EAST.setupConfirmed && room.players.WEST.setupConfirmed && room.players.EAST.abilityReady && room.players.WEST.abilityReady) beginPlay(room);
  else emitRoom(room);
  return {ok:true};
}

function unlockSetup(room, seat) {
  if(room.phase!=='SETUP') return {ok:false,reason:'조패 라운드가 아닙니다.'};
  const p=room.players[seat];
  const opp=room.players[otherSeat(seat)];
  if(!p?.setupConfirmed) return {ok:false,reason:'아직 패를 확정하지 않았습니다.'};
  if(opp?.setupConfirmed) return {ok:false,reason:'상대도 이미 패를 확정했습니다.'};
  p.setupConfirmed=false;
  p.isRiichi=false; p.ippatsu=false; p.abilityReady=false;
  room.setupUnlock[seat]=true;
  emitRoom(room);
  return {ok:true};
}

function forceRandomSetup(room, seat) {
  const p=room.players[seat];
  if(!p || p.setupConfirmed) return;
  const selected=shuffle([...p.private34Tiles]).slice(0,13);
  p.setupTimedOut=true;
  if(p.character==='KAIJI') {
    const waits=new Set(getWaits(selected));
    p.specialRonTiles=shuffle([...Array(34).keys()].filter(t=>!waits.has(t))).slice(0,2);
  }
  if(p.character==='AKAGI' && !p.akagiSuit) p.akagiSuit=shuffle(['m','p','s'])[0];
  p.abilityReady=true;
  lockSetup(room,seat,selected,true);
}

function beginPlay(room) {
  room.phase='PLAYING';
  room.turn='EAST';
  room.turnEndsAt=Date.now()+TURN_MS;
  room.players.EAST.temporaryFuriten=false;
  room.players.WEST.temporaryFuriten=false;
  emitRoom(room);
}

function updateFuriten(player) {
  const own = new Set(player.discardedTiles);
  const wins = [...(player.waits||[]), ...(player.specialRonTiles||[])];
  player.furiten = wins.some(t=>own.has(t));
}

function discard(room, seat, tile) {
  if(room.phase!=='PLAYING' || room.turn!==seat) return {ok:false,reason:'턴이 아닙니다.'};
  if(room.ronRevealEndsAt && Date.now()<room.ronRevealEndsAt) return {ok:false,reason:'론 확인 연출 중입니다. 잠시 기다려주세요.'};
  if(room.ronBlockEndsAt && Date.now()<room.ronBlockEndsAt) return {ok:false,reason:'론 확인 시간입니다. 잠시 기다려주세요.'};
  if(room.turnEndsAt && Date.now()>room.turnEndsAt) return {ok:false,reason:'타임아웃으로 자동 타패됩니다.'};
  const p=room.players[seat];
  const check=canDiscardTile(room,seat,tile);
  if(!check.ok)return check;
  const idx=p.discardCandidates.indexOf(tile);
  p.discardCandidates.splice(idx,1);
  p.discardedTiles.push(tile);
  if (p.discardCount===0 && p.isRiichi) p.riichiDiscardIndex=0;
  p.discardCount++;
  room.lastDiscard=tile;
  room.lastDiscardBy=seat;
  room.turn=otherSeat(seat);
  room.turnEndsAt=Date.now()+TURN_MS;
  room.ronBlockEndsAt=null;
  // 미노가시 후리텐은 이 변형에서는 패가 자동으로 들어오는 드로우가 없으므로
  // 자신의 다음 타패로 해제하지 않고 해당 국 끝까지 유지한다.
  // Ippatsu ends when that player makes their first discard.
  p.ippatsu=false;
  updateFuriten(p);
  // Broadcast only after every discard-related field is finalized so both clients
  // receive the same discardedTiles / lastDiscard / lastDiscardBy / turn snapshot.
  emitRoom(room);
  return {ok:true};
}

function resultHandView(player, winningTile=null) {
  const hand = sortTiles(player.hand13 || []);
  const waits = (player.waits || []).slice().sort((a,b)=>a-b);
  return { hand13: hand, winningTile, waits, tenpai: !!player.isTenpai };
}

function doRon(room, winnerSeat) {
  if(room.phase!=='PLAYING') return {ok:false,reason:'현재 론할 수 없습니다.'};
  const discarder=otherSeat(winnerSeat);
  const tile=room.lastDiscard;
  if(room.lastDiscardBy!==discarder)return {ok:false,reason:'해당 패로 론할 수 없습니다.'};
  const p=room.players[winnerSeat];
  const naturalWait=p.waits.includes(tile);
  const specialWait=p.character==='KAIJI' && p.specialRonTiles.includes(tile) && !naturalWait;
  if(!naturalWait && !specialWait)return {ok:false,reason:'오름패가 아닙니다.'};
  if(p.furiten)return {ok:false,reason:'후리텐입니다.'};
  if(p.temporaryFuriten)return {ok:false,reason:'일시 후리텐입니다.'};
  const evaluated=evaluateRon(room,winnerSeat,tile,discarder);
  if(!evaluated.allowed)return {ok:false,reason:evaluated.reason};
  room.phase='RON_REVEAL';
  room.ronRevealEndsAt=Date.now()+RON_REVEAL_MS;
  room.pendingRon={winner:winnerSeat,loser:discarder,tile,evaluated,endsAt:room.ronRevealEndsAt};
  room.turnEndsAt=null;
  emitRoom(room);
  io.to(room.players.EAST.id).emit('ron_reveal',{winner:winnerSeat,loser:discarder,tile,endsAt:room.ronRevealEndsAt});
  io.to(room.players.WEST.id).emit('ron_reveal',{winner:winnerSeat,loser:discarder,tile,endsAt:room.ronRevealEndsAt});
  return {ok:true,pending:true};
}

function finalizeRon(room) {
  if(room.phase!=='RON_REVEAL' || !room.pendingRon || Date.now()<room.ronRevealEndsAt) return;
  const {winner,loser,tile,evaluated}=room.pendingRon;
  const p=room.players[winner];
  room.phase='RESULT'; room.resultEndsAt=Date.now()+10000;
  const payment=room.stake*evaluated.classification.payout;
  room.players[winner].money += payment;
  room.players[loser].money = Math.max(0, room.players[loser].money - payment);
  const gameOver = room.players[loser].money <= 0;
  const finalRound=!!room.finalRound;
  if(gameOver && finalRound && room.players[winner].money>0) room.stake=1000000;
  room.result={
    type:'RON',winner,loser,tile,han:evaluated.han,fu:evaluated.fu,
    yaku:evaluated.yaku,classification:evaluated.classification.label,payment,
    baseHan:evaluated.baseHan,dora:evaluated.dora,ura:evaluated.ura,special:evaluated.special||null,
    resultEndsAt:room.resultEndsAt,
    winnerHand:resultHandView(p, tile),
    loserHand:resultHandView(room.players[loser], null),
    gameOver, finalRound, finalWinner:gameOver ? winner : null, finalLoser:gameOver ? loser : null, uraIndicator:room.uraDoraIndicator
  };
  p.ippatsu=false; room.players[loser].ippatsu=false;
  room.pendingRon=null; room.ronRevealEndsAt=null; room.ronBlockEndsAt=null; room.turnEndsAt=null;
  emitRoom(room);
}

function doDraw(room) {
  if(room.phase!=='PLAYING') return;
  if(room.players.EAST.discardCount>=DRAW_LIMIT && room.players.WEST.discardCount>=DRAW_LIMIT) {
    room.phase='DRAW';
    room.resultEndsAt=Date.now()+10000;
    const drawStake=room.stake;
    room.players.EAST.money = Math.max(0, room.players.EAST.money - drawStake);
    room.players.WEST.money = Math.max(0, room.players.WEST.money - drawStake);
    const minBalance=Math.min(room.players.EAST.money,room.players.WEST.money);
    const proposed=drawStake*2;
    const nextStake=Math.min(proposed,minBalance);
    room.finalRound=nextStake<proposed && nextStake>0;
    room.stake=nextStake;
    const eastBroke = room.players.EAST.money <= 0;
    const westBroke = room.players.WEST.money <= 0;
    room.result={type:'DRAW',message:'17장씩 타패했지만 화료가 없어 유국',nextStake:room.stake,resultEndsAt:room.resultEndsAt,
      cappedStake:room.finalRound, previousStake:drawStake,
      east:resultHandView(room.players.EAST), west:resultHandView(room.players.WEST),
      gameOver:eastBroke||westBroke, finalRound:room.finalRound,
      finalWinner:eastBroke&&westBroke?null:(eastBroke?'WEST':westBroke?'EAST':null),
      finalLoser:eastBroke&&westBroke?null:(eastBroke?'EAST':westBroke?'WEST':null), uraIndicator:room.uraDoraIndicator};
    emitRoom(room);
  }
}


io.on('connection', socket=>{
  socket.on('create_room', ({nickname,stake,gameMode})=>{
    const code=roomCode();
    const startingMoney=Math.max(Number(stake)||1000000,1000000)*10;
    const mode=gameMode==='CHARACTER'?'CHARACTER':'ORIGINAL';
    const startingStake=Math.max(Number(stake)||1000000,1);
    const room={code,gameMode:mode,charactersLocked:false,stake:startingStake,startingStake,startingMoney,players:{EAST:initialPlayer(socket.id,String(nickname||'Player 1').slice(0,20),'EAST'),WEST:null},dealer:'EAST',roundNumber:1,phase:'WAITING',setupEndsAt:null,turn:null,lastDiscard:null,lastDiscardBy:null,winner:null,result:null,doraIndicator:null,uraDoraIndicator:null,doraPool:[],finalRound:false,doraRevealEndsAt:null,turnEndsAt:null,ronRevealEndsAt:null,ronBlockEndsAt:null,pendingRon:null,setupUnlock:{EAST:false,WEST:false}};
    room.players.EAST.money=startingMoney;
    rooms.set(code,room); socket.join(code); socket.data.roomCode=code;
    socket.emit('room_created',{code}); emitRoom(room);
  });

  socket.on('join_room', ({code,nickname})=>{
    const room=rooms.get(String(code||'').toUpperCase());
    if(!room)return socket.emit('error_message','방을 찾을 수 없습니다.');
    if(room.players.WEST && room.players.EAST?.id!==socket.id)return socket.emit('error_message','방이 가득 찼습니다.');
    if(room.players.EAST.id===socket.id)return;
    room.players.WEST=initialPlayer(socket.id,String(nickname||'Player 2').slice(0,20),'WEST');
    room.players.WEST.money=room.startingMoney;
    socket.join(room.code); socket.data.roomCode=room.code;
    socket.emit('joined_room',{code:room.code});
    io.to(room.code).emit('notice','두 플레이어가 입장했습니다. 게임을 시작합니다.');
    startRound(room);
  });

  socket.on('select_character_draw',({index})=>{
    const room=rooms.get(socket.data.roomCode); if(!room)return;
    const seat=playerSeat(room,socket.id); if(!seat || room.phase!=='CHARACTER_DRAW' || room.characterDrawRevealed)return;
    if(room.characterDrawChoices[seat]!=null)return;
    const i=Number(index); if(!Number.isInteger(i)||i<0||i>8)return;
    room.characterDrawChoices[seat]=i;
    if(room.characterDrawChoices.EAST!=null && room.characterDrawChoices.WEST!=null) resolveCharacterDraw(room);
    else emitRoom(room);
  });

  socket.on('select_character',({character})=>{
    const room=rooms.get(socket.data.roomCode); if(!room)return;
    const seat=playerSeat(room,socket.id); if(!seat)return;
    if(room.gameMode!=='CHARACTER')return;
    if(room.phase!=='CHARACTER_SELECT')return;
    if(room.players[seat].character)return socket.emit('error_message','이미 캐릭터를 선택했습니다.');
    if(room.players[otherSeat(seat)]?.character===character)return socket.emit('error_message','상대가 이미 선택한 캐릭터입니다.');
    finishCharacterSelection(room,seat,String(character||''));
  });

  socket.on('select_dora',()=>{ /* 도라표시패는 서버 연출로 자동 결정 */ });

  socket.on('set_kaiji_tiles',({tiles})=>{
    const room=rooms.get(socket.data.roomCode); if(!room)return;
    const seat=playerSeat(room,socket.id); if(!seat || room.phase!=='SETUP')return;
    const p=room.players[seat]; if(p.character!=='KAIJI' || p.setupConfirmed)return;
    const clean=[...new Set((Array.isArray(tiles)?tiles:[]).map(Number).filter(t=>Number.isInteger(t)&&t>=0&&t<34))];
    if(clean.length!==2)return socket.emit('error_message','카이지 특수 론패를 2장 선택해야 합니다.');
    if(p.hand13?.length===13 && clean.some(t=>getWaits(p.hand13).includes(t)))return socket.emit('error_message','현재 대기패는 특수 론패로 선택할 수 없습니다.');
    p.specialRonTiles=clean; emitRoom(room);
  });

  socket.on('set_akagi_suit',({suit})=>{
    const room=rooms.get(socket.data.roomCode); if(!room)return;
    const seat=playerSeat(room,socket.id); if(!seat || room.phase!=='SETUP')return;
    const p=room.players[seat]; if(p.character!=='AKAGI' || p.setupConfirmed)return;
    if(!['m','p','s'].includes(suit))return socket.emit('error_message','절일문 수패를 선택하세요.');
    p.akagiSuit=suit; p.abilityReady=true; emitRoom(room);
  });

  socket.on('preview_setup',({tiles})=>{
    const room=rooms.get(socket.data.roomCode); if(!room)return;
    const seat=playerSeat(room,socket.id); if(!seat || room.phase!=='SETUP')return;
    const clean=Array.isArray(tiles)?tiles.map(Number).filter(t=>Number.isInteger(t)&&t>=0&&t<34):[];
    socket.emit('setup_preview',{waits:buildWaitPreview(room,seat,clean)});
  });

  socket.on('unlock_setup',()=>{
    const room=rooms.get(socket.data.roomCode); if(!room)return;
    const seat=playerSeat(room,socket.id); if(!seat)return;
    unlockSetup(room,seat);
  });

  socket.on('confirm_hand',({tiles})=>{
    const room=rooms.get(socket.data.roomCode); if(!room)return;
    const seat=playerSeat(room,socket.id); if(!seat)return;
    if(room.phase!=='SETUP')return;
    if(room.setupEndsAt && Date.now()>room.setupEndsAt) room.players[seat].setupTimedOut=true;
    const r=lockSetup(room,seat,tiles,false); if(r?.ok===false) socket.emit('error_message',r.reason);
  });

  socket.on('discard_tile',({tile})=>{
    const room=rooms.get(socket.data.roomCode); if(!room)return;
    const seat=playerSeat(room,socket.id); if(!seat)return;
    const r=discard(room,seat,Number(tile));
    if(!r.ok) return socket.emit('error_message',r.reason);
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
    if(room.result?.gameOver) return socket.emit('error_message','이번 대국이 종료되었습니다.');
    const seat=playerSeat(room,socket.id); if(!seat)return;
    room.nextReady=room.nextReady||{EAST:false,WEST:false};
    room.nextReady[seat]=true;
    const timeUp=!room.resultEndsAt || Date.now()>=room.resultEndsAt;
    if(room.nextReady.EAST && room.nextReady.WEST || timeUp){
      room.roundNumber++;
      const oldEast=room.players.EAST;
      const oldWest=room.players.WEST;
      room.players.EAST=oldWest;
      room.players.WEST=oldEast;
      if(room.players.EAST) room.players.EAST.seat='EAST';
      if(room.players.WEST) room.players.WEST.seat='WEST';
      room.dealer='EAST';
      startRound(room);
    } else {
      emitRoom(room);
    }
  });

  socket.on('restart_game',()=>{
    const room=rooms.get(socket.data.roomCode); if(!room)return;
    const seat=playerSeat(room,socket.id); if(!seat)return;
    room.phase='WAITING'; room.roundNumber=1; room.stake=room.startingStake||1000000; room.finalRound=false; room.uraDoraIndicator=null; room.doraIndicator=null;
    room.charactersLocked=false; room.nextReady={EAST:false,WEST:false}; room.setupUnlock={EAST:false,WEST:false};
    for(const p of [room.players.EAST,room.players.WEST]) if(p){
      p.money=room.startingMoney; p.character=null; p.specialRonTiles=[]; p.akagiSuit=null; p.abilityReady=false; p.murauokaReveal=[];
      p.setupConfirmed=false; p.hand13=[]; p.discardCandidates=[]; p.discardedTiles=[]; p.discardCount=0; p.waits=[]; p.furiten=false; p.temporaryFuriten=false;
    }
    socket.emit('restart_done');
    emitRoom(room);
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
    if(room.phase==='DORA_REVEAL' && room.doraRevealEndsAt && now>=room.doraRevealEndsAt){ finishDoraReveal(room); continue; }
    if(room.phase==='SETUP' && room.setupEndsAt && now>=room.setupEndsAt){
      for(const seat of ['EAST','WEST']){
        const p=room.players[seat];
        if(p && !p.setupConfirmed) forceRandomSetup(room,seat);
      }
      continue;
    }
    if(room.phase==='RON_REVEAL' && room.ronRevealEndsAt && now>=room.ronRevealEndsAt){ finalizeRon(room); continue; }
    if(room.phase==='PLAYING' && room.ronBlockEndsAt && now>=room.ronBlockEndsAt){ room.ronBlockEndsAt=null; emitRoom(room); }
    if(room.phase==='PLAYING' && room.turnEndsAt && now>=room.turnEndsAt){
      const p=room.players[room.turn];
      if(p && p.discardCandidates.length){ const tile=p.discardCandidates[Math.floor(Math.random()*p.discardCandidates.length)]; discard(room,room.turn,tile); doDraw(room); }
      continue;
    }
    if((room.phase==='RESULT'||room.phase==='DRAW') && room.result?.gameOver!==true && room.resultEndsAt && now>=room.resultEndsAt){
      const oldEast=room.players.EAST; const oldWest=room.players.WEST;
      room.roundNumber++; room.players.EAST=oldWest; room.players.WEST=oldEast;
      if(room.players.EAST) room.players.EAST.seat='EAST'; if(room.players.WEST) room.players.WEST.seat='WEST';
      room.dealer='EAST'; startRound(room);
      continue;
    }
    if(room.phase==='PLAYING' && room.players.EAST?.discardCount>=DRAW_LIMIT && room.players.WEST?.discardCount>=DRAW_LIMIT) doDraw(room);
  }
},250);

server.listen(PORT,()=>console.log(`17bo server running at http://localhost:${PORT}`));
