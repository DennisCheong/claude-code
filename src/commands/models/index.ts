import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

export default {
  type: 'local-jsx',
  name: 'models',
  description: 'Show or set the configured Opus, Sonnet, and Haiku models',
  argumentHint: '[opus <model>|sonnet <model>|haiku <model>|all <model>|list]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./models.js'),
} satisfies Command