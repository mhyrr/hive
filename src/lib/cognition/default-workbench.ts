import { CognitionWorkbench } from "./workbench";
import { cognitionTasks } from "./tasks";

export const defaultCognitionWorkbench = new CognitionWorkbench(
  [...cognitionTasks],
);
