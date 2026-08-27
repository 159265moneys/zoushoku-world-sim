// 創世の村とその周りを描く。node game2/test/seat-render.mjs [seed]
import { generate, W, N, T, ORE } from '../src/world/mapgen.js';
import { pickSeat, guarantee, enrich, NEED } from '../src/world/seat.js';
import { writeFileSync } from 'node:fs';

const seed = Number(process.argv[2] || 1);
const g = generate(seed);
const r = pickSeat(g);
if (!r.ok) { console.log('席が置けない', r.why); process.exit(1); }
const wrote = guarantee(g, r.seat);
const log = enrich(g, r.seat);

const COL = {
  [T.SEA]:[24,52,96], [T.LAKE]:[52,110,168], [T.ICE]:[238,244,250], [T.ALP]:[206,206,210],
  [T.MTN]:[146,142,138], [T.HILL]:[166,142,96], [T.WASTE]:[186,168,118], [T.SAND]:[220,202,148],
  [T.MARSH]:[74,108,92], [T.JUNGLE]:[30,78,42], [T.WOOD]:[62,116,60],
  [T.PLAIN]:[136,172,94], [T.GRASS]:[178,190,104], [T.ROCK]:[130,124,118], [T.SALTLAKE]:[200,214,220],
};
const ORECOL = {
  [ORE.IRON]:[70,70,76], [ORE.COPPER]:[200,110,50], [ORE.TIN]:[180,180,200],
  [ORE.GOLD]:[255,214,60], [ORE.LEAD]:[110,110,130], [ORE.STONE]:[230,230,230],
  [ORE.ROCKSALT]:[250,250,200],
};
const colOf = (i) => {
  let c = COL[g.ter[i]] || [255,0,255];
  if (g.land[i]) { const sh = 0.82 + g.h[i]*0.36;
    c = [Math.min(255,c[0]*sh)|0, Math.min(255,c[1]*sh)|0, Math.min(255,c[2]*sh)|0]; }
  if (g.river[i] === 1) c = [96,150,200];
  if (g.river[i] === 2) c = [62,126,196];
  if (g.river[i] === 3) c = [34,100,190];
  if (g.ore[i]) c = g.silver[i] ? [235,235,245] : (ORECOL[g.ore[i]] || c);
  return c;
};

// ── 出力1：全景 768×768、席に十字と12里の環
{
  const S = 2, D = W*S; const px = Buffer.alloc(D*D*3);
  const put = (X,Y,c) => { if(X<0||Y<0||X>=D||Y>=D) return;
    const o=(Y*D+X)*3; px[o]=c[0]; px[o+1]=c[1]; px[o+2]=c[2]; };
  for (let y=0;y<W;y++) for (let x=0;x<W;x++) { const c=colOf(y*W+x);
    for(let dy=0;dy<S;dy++) for(let dx=0;dx<S;dx++) put(x*S+dx,y*S+dy,c); }
  const cx=r.x*S+1, cy=r.y*S+1;
  for (let a=0;a<360;a++){ const t=a*Math.PI/180;                       // 12里の環
    put(Math.round(cx+Math.cos(t)*12*S), Math.round(cy+Math.sin(t)*12*S), [255,60,60]); }
  for (let k=-14;k<=14;k++){ if(Math.abs(k)<4) continue;               // 十字
    put(cx+k,cy,[255,60,60]); put(cx,cy+k,[255,60,60]); }
  writeFileSync(`/tmp/seat-${seed}-world.ppm`, Buffer.concat([Buffer.from(`P6\n${D} ${D}\n255\n`), px]));
}

// ── 出力2：席まわり ±20里 の拡大（1里マス=16px → 656×656）
{
  const R=20, S=16, n=R*2+1, D=n*S; const px=Buffer.alloc(D*D*3);
  const put=(X,Y,c)=>{ if(X<0||Y<0||X>=D||Y>=D) return; const o=(Y*D+X)*3; px[o]=c[0];px[o+1]=c[1];px[o+2]=c[2]; };
  for (let dy=-R;dy<=R;dy++) for (let dx=-R;dx<=R;dx++){
    const x=r.x+dx, y=r.y+dy;
    const c = (x<0||y<0||x>=W||y>=W) ? [0,0,0] : colOf(y*W+x);
    const gx=(dx+R)*S, gy=(dy+R)*S;
    for(let a=0;a<S;a++) for(let b=0;b<S;b++) put(gx+b,gy+a,c);
    // 肥沃≥10 の里マス＝良い土地に印（鉱脈:石も白いので、紫にして分ける）
    if (x>=0&&y>=0&&x<W&&y<W && g.land[y*W+x] && g.fert[y*W+x]>=10)
      for(let a=5;a<11;a++) for(let b=5;b<11;b++)
        if (Math.abs(a-8)+Math.abs(b-8) <= 2) put(gx+b,gy+a,[255,0,220]);
  }
  const cx=R*S+S/2, cy=R*S+S/2;
  for (let a=0;a<720;a++){ const t=a*Math.PI/360;
    put(Math.round(cx+Math.cos(t)*12*S), Math.round(cy+Math.sin(t)*12*S), [255,60,60]);
    put(Math.round(cx+Math.cos(t)*6*S),  Math.round(cy+Math.sin(t)*6*S),  [255,170,60]); }
  for(let a=0;a<S;a++) for(let b=0;b<S;b++) put(R*S+b,R*S+a,[255,40,40]);   // 席
  writeFileSync(`/tmp/seat-${seed}-zoom.ppm`, Buffer.concat([Buffer.from(`P6\n${D} ${D}\n255\n`), px]));
}

const NM={1:'鉄',2:'銅',3:'錫',5:'金',6:'鉛',7:'石',8:'岩塩',silver:'含銀'};
const cnt=(rr,f)=>{let n=0;for(let dy=-rr;dy<=rr;dy++){const y=r.y+dy;if(y<0||y>=W)continue;
  const w=Math.floor(Math.sqrt(rr*rr-dy*dy));
  for(let dx=-w;dx<=w;dx++){const x=r.x+dx;if(x<0||x>=W)continue;if(f(y*W+x))n++;}}return n;};
console.log(`種${seed}  席(${r.x},${r.y})  地形=${Object.keys(T).find(k=>T[k]===g.ter[r.seat])}  肥沃=${g.fert[r.seat]}  川等級=${g.river[r.seat]}  海接続=${g.coast[r.seat]}`);
console.log('保証:', wrote.map(e=>`${NM[e.kind]||e.kind}${e.at===-2?'(海塩)':e.rewrote?'(地形書換)':e.at>=0?'(書込)':'(×)'}`).join(' ') || '全部そこにあった');
console.log(`充実で書き上げた: 糧${log.food}枚 森${log.wood}枚`);
console.log('凡例 … 赤=創世の村／橙の環=6里(森)／赤の環=12里(糧)／紫の菱形=肥沃≥10 の良い土地');
console.log(`席の周り → 肥沃≥10 が ${cnt(12,i=>g.land[i]&&g.fert[i]>=10)}枚/441   森 ${cnt(6,i=>g.ter[i]===T.WOOD||g.ter[i]===T.JUNGLE)}枚/113   居住可能 ${cnt(12,i=>g.hab[i])}枚/441`);
