type Cta = {
  label: string;
  href: string;
};

type HeroSectionProps = {
  eyebrow: string;
  heading: string;
  body: string;
  primaryCta: Cta;
  secondaryCta?: Cta;
};

export function HeroSection({
  eyebrow,
  heading,
  body,
  primaryCta,
  secondaryCta
}: HeroSectionProps) {
  return (
    <section className="landing-hero">
      <p className="landing-eyebrow">{eyebrow}</p>
      <h1>{heading}</h1>
      <p className="landing-hero-body">{body}</p>

      <div className="landing-actions">
        <a className="landing-button landing-button-primary" href={primaryCta.href}>
          {primaryCta.label}
        </a>

        {secondaryCta ? (
          <a className="landing-button landing-button-secondary" href={secondaryCta.href}>
            {secondaryCta.label}
          </a>
        ) : null}
      </div>
    </section>
  );
}
