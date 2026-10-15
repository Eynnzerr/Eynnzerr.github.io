import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

/** Project a torus strand into the fixed 1200 × 630 social-card composition. */
function project(x, y, z) {
  const turn = -.45;
  const tilt = .62;
  const a = x * Math.cos(turn) + z * Math.sin(turn);
  const b = -x * Math.sin(turn) + z * Math.cos(turn);
  const c = y * Math.cos(tilt) - b * Math.sin(tilt);
  const depth = y * Math.sin(tilt) + b * Math.cos(tilt);
  const perspective = 760 / (760 + depth);
  return [895 + a * perspective, 312 + c * perspective];
}

/** Reuse the homepage's open, deformed wave sculpture as vector artwork. */
function sculpture() {
  const strands = [];
  for (let band = 0; band < 54; band++) {
    const v = band / 53 * Math.PI * 2;
    const points = [];
    for (let step = 0; step <= 160; step++) {
      const u = step / 160 * Math.PI * 2;
      const radius = 186 + Math.cos(v) * 59 + Math.sin(u * 3 + v * 1.5) * 15 + Math.sin(u * 2) * 13;
      const [x, y] = project(Math.cos(u) * radius, Math.sin(v) * 102 + Math.cos(u * 2) * 46, Math.sin(u) * radius);
      points.push(`${step === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`);
    }
    const warmth = (Math.sin(v) + 1) / 2;
    const color = `rgb(${Math.round(117 + warmth * 108)},${Math.round(218 - warmth * 57)},${Math.round(190 - warmth * 74)})`;
    strands.push(`<path d="${points.join(' ')}" stroke="${color}" stroke-opacity=".44" stroke-width="${band % 9 === 0 ? 1.6 : .8}"/>`);
  }
  return strands.join('\n');
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="aura"><stop stop-color="#376353" stop-opacity=".24"/><stop offset="1" stop-color="#101e24" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1200" height="630" fill="#101e24"/>
  <ellipse cx="884" cy="324" rx="330" ry="270" fill="url(#aura)"/>
  <g fill="none">${sculpture()}</g>
  <g transform="translate(76 62) scale(.33)" fill="none" stroke="#dce8df" stroke-width="12" stroke-linecap="round" stroke-linejoin="round">
    <path d="M101 28H57C37 28 23 43 23 64S37 100 57 100H101"/>
    <path d="M25 64H46C57 64 59 48 70 48S84 64 96 64H105"/>
  </g>
  <g font-family="Helvetica Neue, Arial, sans-serif">
    <text x="137" y="89" font-size="12" letter-spacing="3" fill="#a4beb2">A PERSONAL SPACE</text>
    <text x="76" y="271" font-size="93" font-weight="500" letter-spacing="-5" fill="#f0f2e9">Eynnzerr<tspan fill="#e6b18d">.</tspan></text>
    <text x="82" y="332" font-size="26" font-weight="400" fill="#bacfc3">Code, sound &amp;</text>
    <text x="82" y="370" font-size="26" font-weight="400" fill="#bacfc3">everything in between.</text>
    <text x="82" y="553" font-size="14" letter-spacing="1.2" fill="#9bb6aa">blog.eynnzerr.cloud</text>
    <text x="1120" y="553" text-anchor="end" font-size="10" letter-spacing="2" fill="#91aaa0">WRITE. BUILD. FEEL.</text>
  </g>
  <path d="M82 503H1118" stroke="#acc7ba" stroke-opacity=".16"/>
  <circle cx="1118" cy="503" r="2.5" fill="#e6b18d"/>
</svg>`;

const svgPath = new URL('../public/images/social-card.svg', import.meta.url);
const pngPath = new URL('../public/images/social-card.png', import.meta.url);
await writeFile(svgPath, svg);
await sharp(Buffer.from(svg)).png().toFile(pngPath.pathname);
