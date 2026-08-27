// 層B（区画）を描く。創世の村の claim 13区画を強調する。node game2/test/parcel-render.mjs [seed]
import { generate, W } from '../src/world/mapgen.js';
import { pickSeat, guarantee, enrich } from '../src/world/seat.js';
import { expand, PW, R } from '../src/world/parcel.js';
import { writeFileSync } from 'node:fs';

const seed = Number(process.argv[2] || 1);
const g = generate(seed);
const r = pickSeat(g); if (!r.ok) { console.log('席が置けない'); process.exit(1); }
guarantee(g, r.seat); enrich(g, r.seat);
const L = expand(g);

const COL = {
  [R.WOOD]:[62,116,60], [R.RIVER]:[62,126,196], [R.WATER]:[34,80,140], [R.ORE]:[226,120,40],
  [R.MTN]:[146,142,138], [R.WASTE]:[186,168,118], [R.PLAIN]:[136,172,94], [R.DEAD]:[226,226,232],
};
const NM = ['森林','川','海湖','鉱脈','山','荒地','平野','畑','菜園','果樹園','牧草地','繊維畑','水田','拠点地','工事中','使用不可'];

const TR = 7, S = 11;                        // ±7里マス ＝ ±28区画、1区画11px
const n = TR*8+1, D = n*S;                   // 57区画 → 627px
const px = Buffer.alloc(D*D*3);
const put=(X,Y,c)=>{ if(X<0||Y<0||X>=D||Y>=D)return; const o=(Y*D+X)*3; px[o]=c[0];px[o+1]=c[1];px[o+2]=c[2]; };
const cx = r.x*4+2, cy = r.y*4+2;            // 席の中心区画
const CLAIM = new Set();
for (let dy=-2;dy<=2;dy++) for (let dx=-2;dx<=2;dx++) if (dx*dx+dy*dy<=4) CLAIM.set?0:CLAIM.add(dy*1000+dx);

for (let dy=-(n>>1); dy<=(n>>1); dy++) for (let dx=-(n>>1); dx<=(n>>1); dx++) {
  const X=cx+dx, Y=cy+dy;
  let c = (X<0||Y<0||X>=PW||Y>=PW) ? [0,0,0] : (COL[L.b0[Y*PW+X]&15] || [255,0,255]);
  const inClaim = CLAIM.has(dy*1000+dx);
  if (!inClaim) c = [c[0]*0.55|0, c[1]*0.55|0, c[2]*0.55|0];      // claim の外は暗く
  const gx=(dx+(n>>1))*S, gy=(dy+(n>>1))*S;
  for(let a=0;a<S;a++) for(let b=0;b<S;b++) put(gx+b,gy+a,c);
  // 里マスの境（4区画ごと）に線
  if (((X%4)+4)%4===0) for(let a=0;a<S;a++) put(gx,gy+a,[40,40,44]);
  if (((Y%4)+4)%4===0) for(let b=0;b<S;b++) put(gx+b,gy,[40,40,44]);
  if (inClaim) { for(let a=0;a<S;a++){ put(gx,gy+a,[255,240,60]); put(gx+S-1,gy+a,[255,240,60]);
                                       put(gx+a,gy,[255,240,60]); put(gx+a,gy+S-1,[255,240,60]); } }
}
{ const gx=(n>>1)*S, gy=(n>>1)*S;                                  // 席そのもの
  for(let a=3;a<S-3;a++) for(let b=3;b<S-3;b++) put(gx+b,gy+a,[255,40,40]); }
writeFileSync(`/tmp/parcel-${seed}.ppm`, Buffer.concat([Buffer.from(`P6\n${D} ${D}\n255\n`), px]));

const cnt={}; let farm=0;
for (let dy=-2;dy<=2;dy++) for (let dx=-2;dx<=2;dx++) { if(dx*dx+dy*dy>4) continue;
  const v = L.b0[(cy+dy)*PW+(cx+dx)]&15; cnt[NM[v]]=(cnt[NM[v]]||0)+1;
  if (v===R.PLAIN||v===R.WOOD||v===R.WASTE) farm++; }
console.log(`種${seed} 席(${r.x},${r.y}) 母地形=${['海','湖','川','湿地','平野','草原','疎林','密林','丘','山','高山','荒地','砂地','岩場','塩湖','氷'][g.ter[r.seat]]} 肥沃=${g.fert[r.seat]} 川=${g.river[r.seat]}`);
console.log('claim の13区画:', Object.entries(cnt).map(([k,v])=>k+v).join(' '));
console.log(`畑にできる ${farm}枚（§2-2 の線は6枚。畑cap=${farm*7} ≥ 38.5 ${farm*7>=38.5?'✓':'✗'}）`);
