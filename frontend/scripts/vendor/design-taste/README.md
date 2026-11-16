# Design linter

Vendored from [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill),
tag `v2.1.5`, commit `12af471f627f866411b4bd785b19646d3672784c`.
MIT license: see LICENSE. No runtime or npm dependencies.

Local corrections exclude comments, resets (`none`), semantic overlay shadow
tokens, accessible focus rings and native checkbox hidden checkmarks. These
are not decorative effects on resting content. Real gradients, decorative
shadows, blur and zero-scale entrances are still checked. Regression examples
are covered by `npm run test:design`. Existing budgets are not increased.
