// ── paste.sh decryption module ─────────────────────────────────────────────
// Exposes window.PasteSh.decrypt(urlWithHash, fetchText) -> Promise<string>
// `fetchText` is injected so this file has no dependency on the network layer.
(() => {
  const te = new TextEncoder();
  const td = new TextDecoder('utf-8', { fatal: false });

  function b64ToBytes(b64) {
    const clean = b64.replace(/\s+/g, '');
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function concat(...arrs) {
    const len = arrs.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(len); let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  }

  async function pbkdf2Sha512(passBytes, salt, iters, dkLen) {
    const baseKey = await crypto.subtle.importKey(
      'raw', passBytes, { name: 'PBKDF2' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-512' }, baseKey, dkLen * 8);
    return new Uint8Array(bits);
  }
  function evpBytesToKey(passBytes, salt, keyLen, ivLen) {
    const need = keyLen + ivLen; let prev = new Uint8Array(0);
    const chunks = []; let total = 0;
    while (total < need) {
      prev = md5(concat(prev, passBytes, salt));
      chunks.push(prev); total += prev.length;
    }
    const all = concat(...chunks);
    return [all.slice(0, keyLen), all.slice(keyLen, keyLen + ivLen)];
  }
  async function aesCbcDecrypt(ct, key, iv) {
    const ck = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, ck, ct);
    return td.decode(new Uint8Array(pt));
  }

  async function decrypt(urlWithHash, fetchText) {
    const hashIdx = urlWithHash.indexOf('#');
    if (hashIdx <= 0) throw new Error('needs #clientkey');
    const baseUrl = urlWithHash.slice(0, hashIdx);
    const clientKey = urlWithHash.slice(hashIdx + 1);
    const id = baseUrl.slice(baseUrl.lastIndexOf('/') + 1);
    if (!id) throw new Error('bad paste id');

    const raw = await fetchText(baseUrl + '.txt');
    const lines = raw.split('\n');
    const serverKey = (lines[0] || '').trim();
    const b64 = lines.slice(1).join('').trim();
    if (!b64) throw new Error('no ciphertext');
    const cb = b64ToBytes(b64);
    if (cb.length < 17) throw new Error('ciphertext too short');
    const salt = cb.slice(8, 16), ct = cb.slice(16);
    const passBytes = te.encode(id + serverKey + clientKey + 'https://paste.sh');

    try {
      const keyIv = await pbkdf2Sha512(passBytes, salt, 1, 48);
      return await aesCbcDecrypt(ct, keyIv.slice(0, 32), keyIv.slice(32, 48));
    } catch (_) {}
    const [k, iv] = evpBytesToKey(passBytes, salt, 32, 16);
    return await aesCbcDecrypt(ct, k, iv);
  }

  // ── tiny pure-JS MD5 (public domain, Joseph Myers, condensed) ────────────
  function md5(bytes) {
    const n = bytes.length;
    const wlen = (((n + 8) >>> 6) + 1) << 4;
    const x = new Int32Array(wlen);
    for (let i = 0; i < n; i++) x[i >> 2] |= bytes[i] << ((i & 3) << 3);
    x[n >> 2] |= 0x80 << ((n & 3) << 3);
    x[wlen - 2] = n << 3;
    x[wlen - 1] = (n >>> 29);
    let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    const add32 = (u, v) => (u + v) | 0;
    const rol = (v, s) => (v << s) | (v >>> (32 - s));
    const cmn = (q, a, b, x, s, t) => add32(rol(add32(add32(a, q), add32(x, t)), s), b);
    const ff = (a,b,c,d,x,s,t)=>cmn((b&c)|((~b)&d),a,b,x,s,t);
    const gg = (a,b,c,d,x,s,t)=>cmn((b&d)|(c&(~d)),a,b,x,s,t);
    const hh = (a,b,c,d,x,s,t)=>cmn(b^c^d,a,b,x,s,t);
    const ii = (a,b,c,d,x,s,t)=>cmn(c^(b|(~d)),a,b,x,s,t);
    for (let i = 0; i < wlen; i += 16) {
      const oa=a, ob=b, oc=c, od=d;
      a=ff(a,b,c,d,x[i+ 0], 7,-680876936); d=ff(d,a,b,c,x[i+ 1],12,-389564586);
      c=ff(c,d,a,b,x[i+ 2],17, 606105819); b=ff(b,c,d,a,x[i+ 3],22,-1044525330);
      a=ff(a,b,c,d,x[i+ 4], 7,-176418897); d=ff(d,a,b,c,x[i+ 5],12, 1200080426);
      c=ff(c,d,a,b,x[i+ 6],17,-1473231341); b=ff(b,c,d,a,x[i+ 7],22,-45705983);
      a=ff(a,b,c,d,x[i+ 8], 7, 1770035416); d=ff(d,a,b,c,x[i+ 9],12,-1958414417);
      c=ff(c,d,a,b,x[i+10],17,-42063);     b=ff(b,c,d,a,x[i+11],22,-1990404162);
      a=ff(a,b,c,d,x[i+12], 7, 1804603682); d=ff(d,a,b,c,x[i+13],12,-40341101);
      c=ff(c,d,a,b,x[i+14],17,-1502002290); b=ff(b,c,d,a,x[i+15],22, 1236535329);
      a=gg(a,b,c,d,x[i+ 1], 5,-165796510); d=gg(d,a,b,c,x[i+ 6], 9,-1069501632);
      c=gg(c,d,a,b,x[i+11],14, 643717713); b=gg(b,c,d,a,x[i+ 0],20,-373897302);
      a=gg(a,b,c,d,x[i+ 5], 5,-701558691); d=gg(d,a,b,c,x[i+10], 9, 38016083);
      c=gg(c,d,a,b,x[i+15],14,-660478335); b=gg(b,c,d,a,x[i+ 4],20,-405537848);
      a=gg(a,b,c,d,x[i+ 9], 5, 568446438); d=gg(d,a,b,c,x[i+14], 9,-1019803690);
      c=gg(c,d,a,b,x[i+ 3],14,-187363961); b=gg(b,c,d,a,x[i+ 8],20, 1163531501);
      a=gg(a,b,c,d,x[i+13], 5,-1444681467); d=gg(d,a,b,c,x[i+ 2], 9,-51403784);
      c=gg(c,d,a,b,x[i+ 7],14, 1735328473); b=gg(b,c,d,a,x[i+12],20,-1926607734);
      a=hh(a,b,c,d,x[i+ 5], 4,-378558);     d=hh(d,a,b,c,x[i+ 8],11,-2022574463);
      c=hh(c,d,a,b,x[i+11],16, 1839030562); b=hh(b,c,d,a,x[i+14],23,-35309556);
      a=hh(a,b,c,d,x[i+ 1], 4,-1530992060); d=hh(d,a,b,c,x[i+ 4],11, 1272893353);
      c=hh(c,d,a,b,x[i+ 7],16,-155497632); b=hh(b,c,d,a,x[i+10],23,-1094730640);
      a=hh(a,b,c,d,x[i+13], 4, 681279174); d=hh(d,a,b,c,x[i+ 0],11,-358537222);
      c=hh(c,d,a,b,x[i+ 3],16,-722521979); b=hh(b,c,d,a,x[i+ 6],23, 76029189);
      a=hh(a,b,c,d,x[i+ 9], 4,-640364487); d=hh(d,a,b,c,x[i+12],11,-421815835);
      c=hh(c,d,a,b,x[i+15],16, 530742520); b=hh(b,c,d,a,x[i+ 2],23,-995338651);
      a=ii(a,b,c,d,x[i+ 0], 6,-198630844); d=ii(d,a,b,c,x[i+ 7],10, 1126891415);
      c=ii(c,d,a,b,x[i+14],15,-1416354905); b=ii(b,c,d,a,x[i+ 5],21,-57434055);
      a=ii(a,b,c,d,x[i+12], 6, 1700485571); d=ii(d,a,b,c,x[i+ 3],10,-1894986606);
      c=ii(c,d,a,b,x[i+10],15,-1051523);   b=ii(b,c,d,a,x[i+ 1],21,-2054922799);
      a=ii(a,b,c,d,x[i+ 8], 6, 1873313359); d=ii(d,a,b,c,x[i+15],10,-30611744);
      c=ii(c,d,a,b,x[i+ 6],15,-1560198380); b=ii(b,c,d,a,x[i+13],21, 1309151649);
      a=ii(a,b,c,d,x[i+ 4], 6,-145523070); d=ii(d,a,b,c,x[i+11],10,-1120210379);
      c=ii(c,d,a,b,x[i+ 2],15, 718787259); b=ii(b,c,d,a,x[i+ 9],21,-343485551);
      a = add32(a, oa); b = add32(b, ob); c = add32(c, oc); d = add32(d, od);
    }
    const out = new Uint8Array(16);
    [a,b,c,d].forEach((v, i) => {
      out[i*4+0] =  v        & 0xff;
      out[i*4+1] = (v >>>  8) & 0xff;
      out[i*4+2] = (v >>> 16) & 0xff;
      out[i*4+3] = (v >>> 24) & 0xff;
    });
    return out;
  }

  window.PasteSh = { decrypt, b64ToBytes };
})();
