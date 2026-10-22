"use client";
/* Film grain as on the LOADOUT homepage (apps/landing NoiseGrain): one fixed canvas of grey noise, redrawn ten times
   a second from a 512px tile. It never takes pointer input. With "reduce motion" on, it draws one still frame. */
import { useEffect, useRef } from "react";

const TILE = 512;
const INTERVAL = 100; // ms between frames
const ALPHA = 51;     // per pixel, out of 255; the canvas is then shown at the opacity set in .grain

function makePattern(ctx: CanvasRenderingContext2D) {
  const tile = document.createElement("canvas");
  tile.width = TILE;
  tile.height = TILE;
  const t = tile.getContext("2d");
  if (!t) return null;
  const noise = t.createImageData(TILE, TILE);
  for (let i = 0; i < noise.data.length; i += 4) {
    noise.data.fill(Math.random() * 255, i, i + 3);
    noise.data[i + 3] = ALPHA;
  }
  t.putImageData(noise, 0, 0);
  return ctx.createPattern(tile, "repeat");
}

export function Grain() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const pattern = makePattern(ctx);
    if (!pattern) return;
    const draw = () => {
      if (!canvas.width || !canvas.height) return;
      const x = Math.floor(Math.random() * TILE);
      const y = Math.floor(Math.random() * TILE);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(1, 0, 0, 1, -x, -y);
      ctx.fillStyle = pattern;
      ctx.fillRect(x, y, canvas.width, canvas.height);
    };
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; draw(); };
    resize();
    window.addEventListener("resize", resize);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = still ? 0 : window.setInterval(() => { if (document.visibilityState === "visible") draw(); }, INTERVAL);
    return () => { window.removeEventListener("resize", resize); window.clearInterval(timer); };
  }, []);
  return <canvas ref={ref} className="grain" aria-hidden="true" role="presentation" />;
}
