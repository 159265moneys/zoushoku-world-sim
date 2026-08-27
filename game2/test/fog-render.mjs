// 霧の見え方を描く。node game2/test/fog-render.mjs [seed] [年数]
import { generate, W, N, T, ORE } from '../src/world/mapgen.js';
import { pickSeat, guarantee, enrich } from '../src/world/seat.js';
import { expand } from '../src/world/parcel.js';
import { settle } from '../src/world/settle.js';
import * as F from '../src/world/fog.js';
import { writeFileSync } from 'node:fs';

const seed = Number(process.argv[2] || 29), years = Number(process.argv[3] || 12);
const nv = Number(process.argv[4] || 1);   // 何村まで育った時点か
const g = generate(seed); const r = pickSeat(g);
guarantee(g, r.seat); enrich(g, r.seat);
const L = expand(g); const S = settle(g, L, r.seat);
const f = F.makeFog();
F.fromSettlements(f, S, Math.min(nv, S.n));
// 斥候は「そのとき最も外側にいる村」から、まだ暗い方角へ出る（実際の使われ方に近づける）
for (let y = 1; y <= years; y++) for (let k = 0; k < 3; k++) {
  const v = Math.min(S.n-1, Math.floor((y*3+k) * S.n / (years*3+3)));
  F.scout(f, (S.vx[v]/4)|0, (S.vy[v]/4)|0, ((y-1)*3+k)*(Math.PI*2/17), 12);
}

const COL = { [T.SEA]:[24,52,96],[T.LAKE]:[52,110,168],[T.ICE]:[238,244,250],[T.ALP]:[206,206,210],
  [T.MTN]:[146,142,138],[T.HILL]:[166,142,96],[T.WASTE]:[186,168,118],[T.SAND]:[220,202,148],
  [T.MARSH]:[74,108,92],[T.JUNGLE]:[30,78,42],[T.WOOD]:[62,116,60],
  [T.PLAIN]:[136,172,94],[T.GRASS]:[178,190,104],[T.ROCK]:[130,124,118],[T.SALTLAKE]:[200,214,220] };
const ORECOL = { [ORE.IRON]:[70,70,76],[ORE.COPPER]:[200,110,50],[ORE.TIN]:[180,180,200],
  [ORE.GOLD]:[255,214,60],[ORE.LEAD]:[110,110,130],[ORE.STONE]:[230,230,230],[ORE.ROCKSALT]:[250,250,200] };

const S_ = 2, D = W*S_; const px = Buffer.alloc(D*D*3);
const put=(X,Y,c)=>{ if(X<0||Y<0||X>=D||Y>=D)return; const o=(Y*D+X)*3; px[o]=c[0];px[o+1]=c[1];px[o+2]=c[2]; };
let un=0,kn=0,se=0;
for (let y=0;y<W;y++) for (let x=0;x<W;x++){
  const i=y*W+x; let c;
  if (!F.isKnown(f,i)) { c=[10,10,14]; un++; }              // 未知＝真っ黒
  else {
    c = COL[g.ter[i]] || [255,0,255];
    if (g.land[i]) { const sh=0.82+g.h[i]*0.36; c=[c[0]*sh|0,c[1]*sh|0,c[2]*sh|0]; }
    if (g.river[i]===1) c=[96,150,200]; if (g.river[i]===2) c=[62,126,196]; if (g.river[i]===3) c=[34,100,190];
    if (g.ore[i]) c = g.silver[i]?[235,235,245]:(ORECOL[g.ore[i]]||c);
    if (!F.isSeen(f,i)) { const a=F.ageOf(f,i);             // 既知だが非可視＝古びる
      const dim=0.45+0.15*Math.max(0,1-a/20);
      c=[c[0]*dim+18|0, c[1]*dim+18|0, c[2]*dim+24|0]; kn++; }
    else se++;
  }
  for(let a=0;a<S_;a++) for(let b=0;b<S_;b++) put(x*S_+b,y*S_+a,c);
}
{ const cx=r.x*S_+1, cy=r.y*S_+1;
  for(let k=-9;k<=9;k++){ if(Math.abs(k)<4)continue; put(cx+k,cy,[255,60,60]); put(cx,cy+k,[255,60,60]); } }
writeFileSync(`/tmp/fog-${seed}.ppm`, Buffer.concat([Buffer.from(`P6\n${D} ${D}\n255\n`), px]));
const t=F.stats(f,g);
console.log(`種${seed} 村${Math.min(nv,S.n)} 斥候3人×${years}年  未知${un} 既知${kn} 可視${se}  陸の既知率${(t.landKnown/t.land*100).toFixed(1)}%  鉱脈${(t.oreKnown/t.ore*100).toFixed(1)}%`);
