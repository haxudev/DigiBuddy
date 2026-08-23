# Profile: product line, price band and trend research

- **Profile id:** product-price-research
- **Base profile:** none

## Dimensions to clarify

| Dimension | Deferrable | Why it decides the shape of the work |
| --- | --- | --- |
| **[market-and-currency] Market and currency** | no | Price bands are comparable only inside one market. A brand with a hundred country stores and a competitor trading in one country can be compared only where they overlap, and the overlap has to be picked before collection, not after. |
| **[category-boundary] Category boundary** | no | Bands dilute fast. Four categories at shallow depth produce four unusable scatters; one shared core category produces a comparison someone can act on. Fix the category before touching a site. |
| **[price-basis] Price basis** | no | List, promoted, from-price and today's asking price are four different numbers. Retailers that discount continuously make the list price a number almost nobody pays. Choosing the basis after seeing the data means choosing whichever basis flatters the story. |
| **[price-publication-asymmetry] Price publication asymmetry** | no | The common and awkward case: one side publishes prices and the other trades through showrooms and publishes none. Decide up front whether the unpriced side gets no band at all, or a third-party band at a lower source tier. Discovering this mid-collection means redoing it. |
| **[taxonomy-source] Taxonomy source** | no | Each brand's own category vocabulary is the default. If the requester needs a common scored grid, that is a different workstream and must not be mixed into source-taxonomy tables. |
| **[trend-baseline] Trend baseline** | no | "Which way are they going" needs a time axis. Ask what supplies it: a prior snapshot, a model-year field the brand publishes, the brand's own new-product flag, or nothing yet. If it is nothing yet, the first run is a baseline and must say so in writing. |
| **[depth-vs-breadth] Depth versus breadth** | no | Every product page is a request. Enumerating a full catalogue and sampling the top of each facet are different methods with different honesty requirements, and the choice changes what the price table is allowed to claim. |

## Step skeleton

1. **[step-fix-frame] Fix the comparison frame.** Market, category, currency, price basis and source tiers, all agreed before collection starts.
2. **[step-diagnose-sites] Diagnose each site's shape.** Does it ship structured data, or render client-side behind bot protection? This decides the collector, and it is cheap to test and expensive to assume.
3. **[step-enumerate-or-sweep] Enumerate or sweep.** Full enumeration where a sitemap or embedded JSON allows it; facet sweep where pagination is unreachable. Record which was used per brand.
4. **[step-capture-site-counts] Capture the site's own counts** wherever it publishes them. A retailer's own product counter is exact and free, and it lets a sampled price table sit beside an exact structure table without either pretending to be the other.
5. **[step-normalise-prices] Normalise prices** onto one basis and keep them separated by source tier.
6. **[step-band-deterministically] Band deterministically.** Snap boundaries to a human ladder, so two runs over the same data produce the same bands.
7. **[step-trend-signals] Extract trend signals and diff.** Model years, new flags, collection pages and designer credits the sites publish about themselves, compared against a prior snapshot where one exists and stated plainly where one does not.
8. **[step-state-coverage] State coverage,** per brand and per axis, with the consequence of each hole.

## Acceptance criteria

- **[criterion-basis-declared]** Price basis and source tier are declared before any price table.
- **[criterion-no-mixed-bands]** No band mixes bases, tiers or currencies.
- **[criterion-quoted-labels]** Every category and sub-style label is quoted from the source that publishes it.
- **[criterion-counts-distinct]** Site-reported counts and sampled counts are visually distinct and are never summed together.
- **[criterion-unpublished-not-zero]** A facet with no published count renders as "not published", never as zero.
- **[criterion-derived-traceable]** Every derived label carries a reason and a verbatim quote.
- **[criterion-unpriced-disclosed]** Where a brand publishes no price, the report says so explicitly and any substitute band is tiered and labelled.
- **[criterion-baseline-stated]** The first run states in writing that it is a baseline.
- **[criterion-no-style-verdict]** No aesthetic or style verdict appears anywhere.
- **[criterion-judgement-scope]** Judgement is limited to product structure, price position, new-product emphasis and observed change, each with its evidence and limitations.
- **[criterion-figures-computed]** Every figure traces to a line of deterministic tool output rather than an arithmetic performed while writing.

## Known pitfalls

**[pitfall-zero-versus-unpublished] Zero versus unpublished.** Writing 0 where the site published no number turns a gap in our reading into a claim about their assortment. This is the most damaging error in this domain because it reads as measured.

**[pitfall-unpublished-is-cheap] Reading "no price published" as "cheap".** A brand that trades through showrooms publishes nothing. An empty price cell next to a competitor's £799 is read by every business reader as a comparison. It is not one.

**[pitfall-url-over-record] Trusting the URL over the record.** Sitemap paths and category slugs are navigational, not authoritative. Where a site ships a canonical category array, that is the taxonomy; the path is a guess that will file armchairs as sofas.

**[pitfall-convenience-flag] Trusting a convenience flag.** Sites ship boolean fields that look authoritative and are maintained inconsistently. Test any such flag against the canonical categories before scoping a whole study on it.

**[pitfall-overlapping-denominator] Coverage percentages over overlapping populations.** A site with four parallel category roots that never states whether they overlap cannot yield one coverage figure. Publishing one anyway invents a denominator.

**[pitfall-band-unpaid-price] Banding a price nobody pays.** Where a retailer discounts continuously, the list price is a marketing artefact. Band what a buyer pays and keep the markdown in the note.

**[pitfall-stale-cache-empty] Letting a stale cache look like an empty page.** A reader that returns 200 and a near-empty body is a failed fetch, not a brand with no products. Treat a suspiciously short body as a transport failure.

**[pitfall-listing-page-price] Attributing a listing page's price to one model.** Search results for a model name land on clearance pages listing dozens of products. Require the manufacturer's model code, and record nothing when several plausible prices sit beside it.

**[pitfall-parsing-change-as-change] Presenting a parsing change as a competitor change.** When the way a field is extracted changes between two captures, every product looks edited. Version the method and suppress field-level differences across a version bump.

**[pitfall-style-creep] Style creep.** The requester usually already knows the competitors' style and says so. Every sentence of aesthetic judgement displaces a sentence of the structure, pricing or direction they actually asked for.
