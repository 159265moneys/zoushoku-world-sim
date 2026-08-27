// 入植の結果を描く。node game2/test/settle-render.mjs [seed]
import { generate, W, T } from '../src/world/mapgen.js';
import { pickSeat, guarantee, enrich } from '../src/world/seat.js';
import { expand } from '../src/world/parcel.js';
import { settle } from '../src/world/settle.js';
import { assignTiers, TIER } from '../src/world/tier.js';
import { writeFileSync } from 'node:fs';

const seed = Number(process.argv[2] || 1);
const g = generate(seed);
const r = pickSeat(g); if (!r.ok) { console.log('席が置けない'); process.exit(1); }
guarantee(g, r.seat); enrich(g, r.seat);
const L = expand(g);
const S_ = settle(g, L, r.seat);
const TG = [400,350,40,16,8,3,1];
const A = assignTiers(g, L, S_, TG);

// 入植した範囲に合わせて切り取る（余白4里）
let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
for (let i=0;i<S_.n;i++){ const x=S_.vx[i]/4, y=S_.vy[i]/4;
  if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; }
x0=Math.max(0,(x0|0)-4); y0=Math.max(0,(y0|0)-4);
x1=Math.min(W-1,(x1|0)+4); y1=Math.min(W-1,(y1|0)+4);
const w=x1-x0+1, h=y1-y0+1;
const S = Math.max(2, Math.min(6, Math.floor(900/Math.max(w,h))));
const D = Math.max(w,h)*S;
const px = Buffer.alloc(D*D*3);
const put=(X,Y,c)=>{ if(X<0||Y<0||X>=D||Y>=D)return; const o=(Y*D+X)*3; px[o]=c[0];px[o+1]=c[1];px[o+2]=c[2]; };

// 地形は薄い灰にして落とす。水だけ少し色を残す
for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
  const i=(y+y0)*W+(x+x0);
  let c;
  if (!g.land[i]) c=[26,34,48];
  else {
    const v = 150 + g.h[i]*70;
    c = g.hab[i] ? [v*0.72|0, v*0.80|0, v*0.66|0] : [v*0.60|0, v*0.58|0, v*0.56|0];
    if (g.river[i]>0) c=[70,96,130];
  }
  for(let a=0;a<S;a++) for(let b=0;b<S;b++) put(x*S+b,y*S+a,c);
}
// 段ごとに大きさと色を変える（開拓地→首都）
const TCOL = [[150,150,160],[190,190,120],[230,200,90],[255,160,60],[255,90,60],[240,50,140],[255,255,255]];
const TRAD = [1,1,2,3,5,7,10];
for (let t=0; t<7; t++) for (let i=0;i<S_.n;i++){        // 小さいものから描いて大を上に
  if (A.tier[i]!==t) continue;
  const X=Math.round((S_.vx[i]/4-x0)*S), Y=Math.round((S_.vy[i]/4-y0)*S);
  const rad=TRAD[t], c=TCOL[t];
  for(let a=-rad;a<=rad;a++) for(let b=-rad;b<=rad;b++)
    if(a*a+b*b<=rad*rad) put(X+b,Y+a,c);
  if (t>=4) for(let a=-rad-2;a<=rad+2;a++) for(let b=-rad-2;b<=rad+2;b++){   // 都市以上に輪
    const d=a*a+b*b; if(d>(rad+1)*(rad+1)&&d<=(rad+2)*(rad+2)) put(X+b,Y+a,[20,20,24]); }
}
writeFileSync(`/tmp/settle-${seed}.ppm`, Buffer.concat([Buffer.from(`P6\n${D} ${D}\n255\n`), px]));
console.log('段: '+A.stat.placed.map((n,i)=>TIER[i].name+n).join(' / ')+'   人口'+A.stat.pop.toLocaleString());
console.log(`種${seed}  村${S_.n}  拠点${S_.hubs.count}  平均${S_.hubs.avg.toFixed(2)}村/拠点  最大${S_.hubs.max}村  1村だけ${S_.hubs.solo}`);
console.log(`広がった範囲 ${w}×${h}里マス（${w*5}×${h*5}km）／ 世界は384×384里マス。使ったのは ${(w*h/(W*W)*100).toFixed(1)}%`);
