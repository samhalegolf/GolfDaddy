type FeatureItem = {
  title: string;
  body: string;
};

type FeatureSectionProps = {
  eyebrow: string;
  heading: string;
  body: string;
  items: FeatureItem[];
};

export function FeatureSection({
  eyebrow,
  heading,
  body,
  items
}: FeatureSectionProps) {
  return (
    <section className="landing-section">
      <div className="landing-section-header">
        <p className="landing-eyebrow">{eyebrow}</p>
        <h2>{heading}</h2>
        <p>{body}</p>
      </div>

      <div className="landing-grid">
        {items.map((item) => (
          <article className="landing-card" key={item.title}>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
