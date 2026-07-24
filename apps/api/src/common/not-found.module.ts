import { Module } from "@nestjs/common";

import { NotFoundController } from "./not-found.controller";

@Module({
  controllers: [NotFoundController],
})
export class NotFoundModule {}
