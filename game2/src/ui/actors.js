// 個体を描く層。**WebGL2 のインスタンス描画。1体 = 1クアッド + シェーダ。**
//
// キャラビジュアル.md §8 より：
//   詰まっていたのは Canvas2D の弧のラスタライズ（arc が 2.2μs）1つだけ。
//   実測（Apple M5）：10万体 1.33ms（60fps の予算 16.7ms の 8%）。Canvas2D の165倍。
//   **背景・エリア・家の箱・名札は Canvas2D のまま。**ここは個体だけを引き受ける。
//
// 何を描くか（§1 の記号の全部）：
//   色相      血の1位            ← 血。**これだけ。他の意味を載せない**
//   沈殿      血の2位が下に溜まる ← 混血度。**色相を平均しない**
//   角の数    0=丸／3〜8角        ← 血統
//   星・ハート 潜性の形質          ← 血統
//   縦横の線  模様（交点＝水玉）   ← 血統
//   大きさ    年齢
//   明度      弱っている、それだけ
//   彩度      生死
//   目        生きていること。死ぬと閉じる。18px 以下では出さない
//
// 掟：**色に新しい意味を載せない。**「危険は赤」の類をこのファイルに一行も書かない。

const VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_pos;      // x, y, r, dark
layout(location=2) in vec4 a_blood;    // hue1, hue2, sediment, sat
layout(location=3) in vec4 a_form;     // corners, special, stripeV, stripeH
uniform vec2 u_res;
out vec2 v_uv; out vec4 v_blood; out vec4 v_form; out float v_px; out float v_dark;
void main(){
  v_uv = a_corner; v_blood = a_blood; v_form = a_form;
  v_px = a_pos.z; v_dark = a_pos.w;
  vec2 p = a_pos.xy + a_corner * a_pos.z;
  gl_Position = vec4(p / u_res * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_uv; in vec4 v_blood; in vec4 v_form; in float v_px; in float v_dark;
out vec4 o;
const float TAU = 6.2831853;

vec3 hsl(float h, float s, float l){
  vec3 k = mod(vec3(0.0,8.0,4.0) + h/30.0, 12.0);
  float a = s * min(l, 1.0-l);
  return l - a * clamp(min(k-3.0, 9.0-k), -1.0, 1.0);
}

// この向きの輪郭までの距離。角は落とす。
// 向きは揃える：多角形は底が平ら、星は先が上。揃えないと並んだとき雑に見える
float boundary(float ang, float n, float special){
  if (special > 1.5) {                        // ハート（極座標のハート曲線）
    float th = atan(-sin(ang), cos(ang));
    float st = sin(th);
    float r = 2.0 - 2.0*st + st*sqrt(abs(cos(th)))/(st + 1.4);
    return clamp(r / 3.5, 0.05, 1.0);
  }
  if (special > 0.5) {                        // 星（5つ尖り・先は上）
    float w = 0.5 + 0.5*cos(5.0*ang + 1.5708);
    return mix(0.40, 1.0, pow(w, 2.0));
  }
  if (n < 2.5) return 1.0;                    // 丸
  float seg = TAU / n;
  float ap  = cos(seg*0.5);
  float a   = mod(ang - 1.5708 + seg*0.5, seg) - seg*0.5;
  // 角の落とし方は角数に比例させる。一律だと三角が扇になる（内接/外接が0.5しかない）
  return mix(ap / cos(a), 1.0, 0.30 * ap);
}

void main(){
  vec2 uv = v_uv;
  float d = length(uv);
  if (d > 1.02) discard;
  float rn = boundary(atan(uv.y, uv.x), v_form.x, v_form.y);
  float aa = max(fwidth(d), 0.6/max(v_px,1.0));
  float alpha = smoothstep(rn+aa, rn-aa, d);
  if (alpha <= 0.003) discard;

  float lig = 0.66 * (1.0 - 0.42 * v_dark);   // 明度＝弱っている、それだけ
  float sed = v_blood.z;                       // 沈殿＝血の2位の割合
  float line = 1.0 - 2.0*sed;
  float hue = mix(v_blood.x, v_blood.y, smoothstep(line - aa, line + aa, uv.y));
  vec3 col = hsl(hue, v_blood.w, lig);

  if (v_px > 5.0) {                            // 模様。縦と横が両方あれば交点＝水玉
    float nv = v_form.z, nh = v_form.w;
    float mv = nv > 0.5 ? abs(fract((uv.x + 1.0) * nv * 0.5) - 0.5) : 1.0;
    float mh = nh > 0.5 ? abs(fract((uv.y + 1.0) * nh * 0.5) - 0.5) : 1.0;
    float th = 0.16, ink = 0.0;
    if (nv > 0.5 && nh > 0.5)      ink = (1.0-smoothstep(th*0.7, th, mv)) * (1.0-smoothstep(th*0.7, th, mh));
    else if (nv > 0.5 || nh > 0.5) ink = 1.0 - smoothstep(th*0.7, th, min(mv, mh));
    col = mix(col, col * 0.62, ink * 0.85);
  }
  if (v_px > 9.0) {                            // 目。18px 以下では読めないので出さない
    float e = min(length(uv - vec2(-0.34,-0.20)), length(uv - vec2(0.34,-0.20)));
    col = mix(col, vec3(0.09,0.08,0.07), 1.0 - smoothstep(0.13, 0.17, e));
  }
  o = vec4(col, alpha);
}`;

const FLOATS = 12;              // pos4 + blood4 + form4

export class ActorLayer {
  /** @param {HTMLCanvasElement} canvas 2Dの盤面に重ねる、透明なキャンバス */
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.cap = 0;
    this.n = 0;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: false });
    if (!gl) return;                       // WebGL2 が無い環境。呼び手が 2D に落とす
    this.gl = gl;

    const sh = (t, src) => {
      const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.uRes = gl.getUniformLocation(prog, 'u_res');

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // 12個ぜんぶを1本の配列に交互に置く。**10万までは毎フレーム全部送っても差が出ない**
    // （実測：split と full で±10%。差が出るのは50万から）。実装を単純にする
    this.buf = gl.createBuffer();
    const stride = FLOATS * 4;
    for (let k = 0; k < 3; k++) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.enableVertexAttribArray(1 + k);
      gl.vertexAttribPointer(1 + k, 4, gl.FLOAT, false, stride, k * 16);
      gl.vertexAttribDivisor(1 + k, 1);
    }
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.data = new Float32Array(0);
    this.ok = true;
  }

  /** 1フレームぶんの積み込みを始める */
  begin(count) {
    this.n = 0;
    if (!this.ok) return;
    if (count > this.cap) {
      this.cap = Math.max(1024, 1 << (32 - Math.clz32(count)));
      this.data = new Float32Array(this.cap * FLOATS);
    }
  }

  /**
   * 1体積む。**座標は画面座標（devicePixelRatio を掛けたあと）**。
   * sim は座標を知らないので、掛け算は呼び手（map.js）の仕事。
   */
  push(x, y, r, dark, hue1, hue2, sediment, sat, corners, special, stripeV, stripeH) {
    if (!this.ok || this.n >= this.cap) return;
    const d = this.data, o = this.n * FLOATS;
    d[o]    = x; d[o+1] = y; d[o+2] = r; d[o+3] = dark;
    d[o+4]  = hue1; d[o+5] = hue2; d[o+6] = sediment; d[o+7] = sat;
    d[o+8]  = corners; d[o+9] = special; d[o+10] = stripeV; d[o+11] = stripeH;
    this.n++;
  }

  /** 積んだぶんを出す。2Dの盤面の上に重なる */
  flush() {
    if (!this.ok) return;
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.n === 0) return;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.n * FLOATS), gl.DYNAMIC_DRAW);
    gl.uniform2f(this.uRes, this.canvas.width, this.canvas.height);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
  }

  resize(wCss, hCss, dpr) {
    this.canvas.width = Math.max(1, Math.round(wCss * dpr));
    this.canvas.height = Math.max(1, Math.round(hCss * dpr));
    this.canvas.style.width = wCss + 'px';
    this.canvas.style.height = hCss + 'px';
    if (this.ok) this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }
}
