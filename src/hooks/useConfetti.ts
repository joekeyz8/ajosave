"use client";

/**
 * useConfetti — Lightweight confetti animation
 *
 * Respects prefers-reduced-motion preference.
 * Uses canvas for performance.
 * ~2kB uncompressed.
 */

import { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

export function useConfetti(options: { duration?: number; density?: number } = {}) {
  const { duration = 3000, density = 50 } = options;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Respect prefers-reduced-motion
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas size to window size
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const particles: Particle[] = [];
    const startTime = Date.now();

    // Create initial particles
    for (let i = 0; i < density; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: -20,
        vx: (Math.random() - 0.5) * 8,
        vy: Math.random() * 4 + 3,
        life: 1,
        maxLife: 1,
      });
    }

    const animate = () => {
      const elapsed = Date.now() - startTime;

      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Update and draw particles
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];

        // Fade out
        p.life = 1 - elapsed / duration;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }

        // Physics
        p.vy += 0.1; // gravity
        p.x += p.vx;
        p.y += p.vy;

        // Draw confetti
        ctx.globalAlpha = p.life;
        ctx.fillStyle = ["#FFD700", "#FF69B4", "#00CED1", "#FF6347", "#32CD32"][i % 5];
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((elapsed / 50) * Math.PI);
        ctx.fillRect(-5, -2, 10, 4);
        ctx.restore();
      }

      ctx.globalAlpha = 1;

      if (particles.length > 0 && elapsed < duration) {
        requestAnimationFrame(animate);
      }
    };

    animate();

    // Handle window resize
    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [duration, density]);

  return canvasRef;
}
