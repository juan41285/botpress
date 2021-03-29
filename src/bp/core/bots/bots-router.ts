import { Logger, RouterOptions } from 'botpress/sdk'
import { HTTPServer } from 'core/app/server'
import { BotService } from 'core/bots'
import { ConfigProvider } from 'core/config'
import { ConverseRouter, ConverseService } from 'core/converse'
import { disableForModule } from 'core/routers'
import {
  AuthService,
  TOKEN_AUDIENCE,
  checkMethodPermissions,
  checkTokenHeader,
  needPermissions,
  checkBotVisibility
} from 'core/security'
import { NLUService } from 'core/services/nlu/nlu-service'
import { HintsRouter, HintsService } from 'core/user-code'
import { WorkspaceService } from 'core/users'
import express, { Express, RequestHandler, Router } from 'express'
import { AppLifecycle, AppLifecycleEvents } from 'lifecycle'
import _ from 'lodash'
import { URL } from 'url'

import { NLURouter } from '../routers/bots/nlu'
import { CustomRouter } from '../routers/customRouter'

export class BotsRouter extends CustomRouter {
  private checkTokenHeader: RequestHandler
  private needPermissions: (operation: string, resource: string) => RequestHandler
  private checkMethodPermissions: (resource: string) => RequestHandler
  private nluRouter: NLURouter
  private hintsRouter: HintsRouter
  private converseRouter: ConverseRouter

  constructor(
    private botService: BotService,
    private configProvider: ConfigProvider,
    private authService: AuthService,
    private workspaceService: WorkspaceService,
    private nluService: NLUService,
    private converseService: ConverseService,
    private hintsService: HintsService,
    private logger: Logger,
    private httpServer: HTTPServer
  ) {
    super('Bots', logger, Router({ mergeParams: true }))

    this.needPermissions = needPermissions(this.workspaceService)
    this.checkMethodPermissions = checkMethodPermissions(this.workspaceService)
    this.checkTokenHeader = checkTokenHeader(this.authService, TOKEN_AUDIENCE)

    this.nluRouter = new NLURouter(this.logger, this.authService, this.workspaceService, this.nluService)
    this.converseRouter = new ConverseRouter(this.logger, this.converseService, this.authService, this.httpServer)
    this.hintsRouter = new HintsRouter(this.logger, this.hintsService, this.authService, this.workspaceService)
  }

  async setupRoutes(app: express.Express) {
    app.use('/api/v1/bots/:botId', this.router)
    this.router.use(checkBotVisibility(this.configProvider, this.checkTokenHeader))

    this.router.use('/converse', this.converseRouter.router)
    this.router.use('/nlu', this.nluRouter.router)
    this.router.use('/hints', this.hintsRouter.router)

    this.router.get(
      '/',
      this.checkTokenHeader,
      this.needPermissions('read', 'bot.information'),
      this.asyncMiddleware(async (req, res) => {
        const bot = await this.botService.findBotById(req.params.botId)
        if (!bot) {
          return res.sendStatus(404)
        }

        res.send(bot)
      })
    )

    this.router.get(
      '/workspaceBotsIds',
      this.checkTokenHeader,
      this.needPermissions('read', 'bot.information'),
      this.asyncMiddleware(async (req, res) => {
        const botsRefs = await this.workspaceService.getBotRefs(req.workspace)
        const bots = await this.botService.findBotsByIds(botsRefs)

        return res.send(bots?.filter(Boolean).map(x => ({ name: x.name, id: x.id })))
      })
    )
  }

  /**
   * There is no built-in API in express to remove routes at runtime. Therefore, it is recommended to use this method in development only.
   * A good explanation is available here: https://github.com/expressjs/express/issues/2596
   */
  deleteRouter(path: string, app: Express) {
    const relPath = `/mod/${path}`

    // We need to access the global stack and dig in it to find the desired stack
    const mainRouterStack = app._router.stack
    const botRouter = mainRouterStack.find(x => x.name === 'router' && x.regexp.exec('/api/v1/bots/:botId'))

    if (botRouter) {
      botRouter.handle.stack = botRouter.handle.stack.filter(x => !x.regexp.exec(relPath))
    }
  }

  getNewRouter(path: string, identity: string, options?: RouterOptions): Router {
    const router = Router({ mergeParams: true })
    if (_.get(options, 'checkAuthentication', true)) {
      router.use(this.checkTokenHeader)

      if (options?.checkMethodPermissions) {
        router.use(this.checkMethodPermissions(identity))
      } else {
        router.use(this.needPermissions('write', identity))
      }
    }

    if (!_.get(options, 'enableJsonBodyParser', true)) {
      disableForModule('bodyParserJson', path)
    }

    if (!_.get(options, 'enableUrlEncoderBodyParser', true)) {
      disableForModule('bodyParserUrlEncoder', path)
    }

    const relPath = `/mod/${path}`
    this.router.use(relPath, router)

    router['getPublicPath'] = async () => {
      await AppLifecycle.waitFor(AppLifecycleEvents.HTTP_SERVER_READY)
      const externalUrl = new URL(process.EXTERNAL_URL)
      const subPath = `${externalUrl.pathname}/api/v1/bots/BOT_ID${relPath}`
      return new URL(subPath.replace('//', '/'), externalUrl.origin).href
    }

    return router
  }
}
