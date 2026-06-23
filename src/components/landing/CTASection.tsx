type Cta = {
  label: string;
  href: string;
};

type CTASectionProps = {
  heading: string;
  body: string;
  primaryCta: Cta;
  secondaryCta?: Cta;
};

export function CTASection({ heading, body, primaryCta, secondaryCta }: CTASectionProps) {
  return (
    <section className="landing-cta">
      <h2>{heading}</h2>
      <p>{body}</p>

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
