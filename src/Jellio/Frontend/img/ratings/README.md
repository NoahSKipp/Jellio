# Rating source marks

The mark shown next to a real CommunityRating everywhere this runtime
displays one (`components/ratingBadge.js`), so a bare star and a number
stop reading as a rating from nowhere in particular.

## Where this came from

`tmdb.svg` is taken unmodified from [Simple Icons](https://github.com/simple-icons/simple-icons)
16.28.0 (`themoviedatabase.svg`), whose icon files are released under CC0
1.0 Universal. That licence is reproduced in `LICENSE.md` beside it, same
as `img/services/`.

CC0 covers the file. It does not and cannot cover the mark itself: it
remains the trademark of The Movie Database, used here only to identify
where a rating this runtime displays actually comes from. That is the
ordinary nominative use every media client makes of it, but it is a use,
not a grant.

## Why only one file

Every CommunityRating this runtime ever renders comes from the same real
source: Gelato's own TMDB backed catalog import. There is no per-item
field naming a different provider, so one fixed badge covers every one
of them rather than a whole folder of rating source marks this runtime
would have no real way to pick between.

## Adding one

Same rule as `img/services/`: monochrome, `components/ratingBadge.js`
forces it white with the same CSS filter that folder's own logos already
use rather than trusting whatever fill the file ships with.
