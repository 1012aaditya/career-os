import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';

import { AuthGuard } from '../../auth/auth.guard.js';
import { MarketSearchQueryDto } from './market-search.dto.js';
import { MarketSearchService } from './market-search.service.js';
import { DEFAULT_PAGE_SIZE } from './search-ruleset.js';

/*
 * The Market Search read API.
 *
 * Mounted under the same 'market' prefix and the same class-level
 * AuthGuard as the rest of the Market Graph, so it inherits the existing
 * authentication, the URI versioning that puts /v1 in front of it, and
 * the global ValidationPipe. It introduces no new architectural style.
 *
 * READ ONLY, like everything else here. There is no POST, no PATCH and
 * nothing that writes: building the projection is a CLI job, because an
 * index rebuild is not something a phone should be able to trigger.
 *
 * SEPARATE from MarketGraphController rather than added to it, because
 * the two answer different questions. That one serves aggregate signals
 * about the market; this one serves individual postings. Keeping them
 * apart keeps the pinned route table readable and makes it obvious which
 * surface a new route is joining.
 *
 * A note on the DTO, since it breaks with the neighbouring controller's
 * hand-rolled parseLimit. That convention exists because the global
 * pipe's forbidNonWhitelisted answers an unexpected query parameter with
 * a 400, which is the wrong answer for an optional page size on a simple
 * endpoint. Here it is exactly the RIGHT answer: this is the one surface
 * where an unrecognised parameter is most likely to be someone probing
 * for a field that becomes an ORDER BY, and section 24 asks for it
 * explicitly.
 */
@Controller('market')
@UseGuards(AuthGuard)
export class MarketSearchController {
  constructor(private readonly search: MarketSearchService) {}

  @Get('search')
  find(@Query() query: MarketSearchQueryDto) {
    /*
     * The clock is read HERE, at the request edge, and threaded down as
     * an explicit instant - the same rule the signal explanation follows.
     * Read inside the service it would be read more than once per
     * response, and two results in one body could then carry freshness
     * verdicts taken against different instants.
     */
    return this.search.search(
      {
        q: query.q,
        role: query.role,
        location: query.location,
        skills: query.skills,
        company: query.company,
        sources: query.sources,
        freshness: query.freshness,
        publishedWithinDays: query.publishedWithinDays,
        sort: query.sort ?? 'relevance',
        limit: query.limit ?? DEFAULT_PAGE_SIZE,
        cursor: query.cursor,
      },
      new Date(),
    );
  }

  /**
   * One posting, in full.
   *
   * The id is the posting's own identifier, validated as a uuid before it
   * reaches a query. A malformed id is a 400 and an unknown one is a 404;
   * a posting from a source we may not redistribute is ALSO a 404, so the
   * response cannot be used to discover which postings exist behind that
   * boundary.
   */
  @Get('postings/:id')
  posting(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.search.posting(id, new Date());
  }
}
