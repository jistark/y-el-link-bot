export interface Article {
  title: string;
  subtitle?: string;
  author?: string;
  date?: string;
  body: string;
  images?: { url: string; caption?: string }[];
  url: string;
  source: 'elmercurio' | 'lasegunda' | 'latercera' | 'df' | 'theverge' | 'lun' | 'nyt' | 'wapo' | 'cnnchile' | 'biobio' | 'elpais' | 'ft' | 'theatlantic' | 'wired' | '404media' | 'substack' | 'beehiiv';
}

export type TelegraphNode =
  | string
  | {
      tag: string;
      attrs?: Record<string, string>;
      children?: TelegraphNode[];
    };

export interface TelegraphPage {
  path: string;
  url: string;
  title: string;
  description: string;
  views: number;
}
