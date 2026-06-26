const COUNT = 5;
const DURATION = 3.4;
const RINGS = Array.from({ length: COUNT }, (_, i) => ({
  delay: -(i * (DURATION / COUNT)),
  id: `p${i}`,
}));

export const PulseRadar = () => (
  <div className="grid h-[320px] w-full place-items-center [perspective:800px]">
    <div className="relative size-px [transform:rotateX(58deg)] [transform-style:preserve-3d]">
      <div className="monolith-grid absolute inset-0 m-auto size-80 rounded-full opacity-20" />
      {RINGS.map((r) => (
        <div
          className="absolute inset-0 m-auto size-72 rounded-full border-2 border-native/50 motion-safe:animate-[pulse-ring_3.4s_ease-out_infinite]"
          key={r.id}
          style={{ animationDelay: `${r.delay}s` }}
        />
      ))}
      <div className="absolute inset-0 m-auto size-3 rounded-full bg-native shadow-[0_0_24px_var(--native)]" />
    </div>
  </div>
);
