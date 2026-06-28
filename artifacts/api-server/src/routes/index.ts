import { Router, type IRouter } from "express";
import healthRouter from "./health";
import playersRouter from "./players";
import teamsRouter from "./teams";
import dashboardRouter from "./dashboard";
import metaRouter from "./meta";
import syncRouter from "./sync";
import statsRouter from "./stats";

const router: IRouter = Router();

router.use(healthRouter);
router.use(playersRouter);
router.use(teamsRouter);
router.use(dashboardRouter);
router.use(metaRouter);
router.use(syncRouter);
router.use(statsRouter);

export default router;
