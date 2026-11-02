/**
 * The supporter & contributor lists — sponsors, promoters, testers,
 * code/theme/packaging contributors, and community issue reporters — from the
 * single source of truth (`public/sponsors.json`: this site, the README script,
 * and the app's About dialog).
 */
import data from '../../public/sponsors.json';

export interface Sponsor {
  name: string;
  since: string;
  github?: string;
  url?: string;
}

export interface Promoter {
  name: string;
  since: string;
  /** Where it was published: "Bilibili", "少数派", "YouTube", "Blog"… */
  platform: string;
  /** The article / video / post itself. */
  url: string;
  /** Their referral code, as in solomd.app/?ref=<code>. */
  ref?: string;
  github?: string;
  /** Shown as a card on the homepage, with `quote`. */
  featured?: boolean;
  quote?: string;
}

export interface Tester {
  name: string;
  since: string;
  /** What they tested, per language. */
  contribution: { en: string; zh: string };
  github?: string;
}

export interface Contributor {
  name: string;
  github?: string;
  url?: string;
  since: string;
  kind: 'code' | 'theme' | 'packaging';
  prs?: string[];
  contribution: { en: string; zh: string };
}

export interface CommunityReporter {
  name: string;
  url: string;
  platform: 'github' | 'gitee';
}

type RawReporter = string | { name: string; github?: string; gitee?: string };

export const sponsors: Sponsor[] = (data as { sponsors: Sponsor[] }).sponsors ?? [];
export const promoters: Promoter[] = ((data as { promoters?: Promoter[] }).promoters ?? [])
  .slice()
  .sort((a, b) => (a.since < b.since ? 1 : -1));
export const testers: Tester[] = (data as { testers?: Tester[] }).testers ?? [];
export const contributors: Contributor[] = (data as { contributors?: Contributor[] }).contributors ?? [];

const rawReporters: RawReporter[] =
  (data as { communityReporters?: RawReporter[] }).communityReporters ?? [];

export const communityReporters: CommunityReporter[] = rawReporters.map((item) => {
  if (typeof item === 'string') {
    return {
      name: `@${item}`,
      url: `https://github.com/${item}`,
      platform: 'github',
    };
  }
  if (item.gitee) {
    return {
      name: item.name,
      url: `https://gitee.com/${item.gitee}`,
      platform: 'gitee',
    };
  }
  return {
    name: item.name,
    url: item.github ? `https://github.com/${item.github}` : 'https://github.com/zhitongblog/solomd/issues',
    platform: 'github',
  };
});

export const featuredPromoters = promoters.filter((p) => p.featured && p.quote);

export const PROMOTE_ISSUE_URL =
  'https://github.com/zhitongblog/solomd/issues/new?template=promotion.yml';
export const PROMOTE_GITEE_URL = 'https://gitee.com/zhitong45/solomd/issues/new';
export const PROMOTE_EMAIL = 'slushy@139.com';
