import { landingContent } from "../content/landingContent";
import { HeroSection } from "../components/landing/HeroSection";
import { FeatureSection } from "../components/landing/FeatureSection";
import { ProductSection } from "../components/landing/ProductSection";
import { CTASection } from "../components/landing/CTASection";

export function LandingPage() {
  return (
    <main className="landing-page">
      <HeroSection {...landingContent.hero} />
      <FeatureSection {...landingContent.features} />
      <ProductSection {...landingContent.products} />
      <CTASection {...landingContent.cta} />
    </main>
  );
}
