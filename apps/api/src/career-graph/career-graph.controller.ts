import {
  Controller,
  Get,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import type { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard.js';
import { CareerGraphService } from './career-graph.service.js';

type AuthenticatedRequest = Request & {
  user?: {
    id?: string;
  };
};

@Controller('career-graph')
@UseGuards(AuthGuard)
export class CareerGraphController {
  constructor(
    private readonly careerGraphService: CareerGraphService,
  ) {}

  @Get()
  async getGraph(
    @Req() request: AuthenticatedRequest,
  ) {
    const userId = request.user?.id;

    if (!userId) {
      throw new UnauthorizedException(
        'Authentication required',
      );
    }

    return this.careerGraphService.getGraph(userId);
  }
}