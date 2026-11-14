/**
 * The regular expression runs here, off the page's thread. If a pattern backtracks without end,
 * the page terminates this worker and starts another; the page itself never runs the pattern.
 */
import { runRegex, type RegexRequest, type RegexResponse } from '../../core/regex/run';
import { serve } from '../util-shared/worker-host';

serve<RegexRequest, RegexResponse>(runRegex);
