// The Command screen (mobile CommandScreen): the voice stage first, agents and live panels
// beside it on wide screens; every block arrives with the mobile app's staggered spring.
import { motion } from 'framer-motion';
import { enter } from '../ui';
import { VoiceStage } from './command/VoiceStage';
import { AgentsPanel, InfoTabs, QuickActions, WorldClocks } from './command/Panels';

export function CommandScreen() {
  return (
    <div className="h-full overflow-y-auto px-4 pt-5 pb-36 md:px-6 scrollbar-thin">
      <div className="mx-auto grid max-w-[1560px] gap-5 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <motion.div {...enter(0)}><VoiceStage /></motion.div>
          <motion.div {...enter(2)}><QuickActions /></motion.div>
          <motion.div {...enter(3)}><WorldClocks /></motion.div>
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <motion.div {...enter(1)}><AgentsPanel /></motion.div>
          <motion.div {...enter(2)}><InfoTabs /></motion.div>
        </div>
      </div>
    </div>
  );
}
