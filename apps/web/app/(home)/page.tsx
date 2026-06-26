import { Agents } from "@/components/sections/agents";
import { Cta } from "@/components/sections/cta";
import { Hero } from "@/components/sections/hero";
import { ProviderMarquee } from "@/components/sections/provider-marquee";
import { Stats } from "@/components/sections/stats";
import { ValueProps } from "@/components/sections/value-props";
import { getLatestVersion } from "@/lib/version";

const Home = () => {
  const latestVersion = getLatestVersion();

  return (
    <>
      <Hero latestVersion={latestVersion} />
      <ProviderMarquee />
      <ValueProps />
      <Stats />
      <Agents />
      <Cta />
    </>
  );
};

export default Home;
