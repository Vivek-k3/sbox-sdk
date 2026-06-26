import { Capabilities } from "@/components/sections/capabilities";
import { GetStarted } from "@/components/sections/get-started";
import { Hero } from "@/components/sections/hero";
import { getLatestVersion } from "@/lib/version";

const Home = () => {
  const latestVersion = getLatestVersion();

  return (
    <>
      <Hero adapterCount={4} latestVersion={latestVersion} />
      <Capabilities />
      <GetStarted />
    </>
  );
};

export default Home;
