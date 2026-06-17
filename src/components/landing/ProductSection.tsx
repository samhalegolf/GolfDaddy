type LandingProduct = {
  title: string;
  body: string;
  cta?: {
    label: string;
    href: string;
  };
};

type ProductSectionProps = {
  eyebrow: string;
  heading: string;
  body: string;
  items: LandingProduct[];
};

export function ProductSection({ eyebrow, heading, body, items }: ProductSectionProps) {
  return (
    <section className="landing-section landing-product-section">
      <div className="landing-section-header">
        <p className="landing-eyebrow">{eyebrow}</p>
        <h2>{heading}</h2>
        <p>{body}</p>
      </div>

      <div className="landing-grid">
        {items.map((item) => (
          <article className="landing-card landing-product-card" key={item.title}>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
            {item.cta ? (
              <a className="landing-card-link" href={item.cta.href}>
                {item.cta.label}
              </a>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
