export interface Article {
  title: string;
  kicker?: string;
  subtitle?: string;
  author?: string;
  date?: string;
  body: string;
  images?: { url: string; caption?: string }[];
  coverImage?: { url: string; caption?: string };  // social/preview image
  url: string;
  source: 'elmercurio' | 'lasegunda' | 'latercera' | 'df' | 'theverge' | 'lun' | 'nyt' | 'wapo' | 'cnnchile' | 'biobio' | 'elpais' | 'ft' | 'theatlantic' | 'wired' | '404media' | 'bloomberg' | 'adnradio' | 'elfiltrador' | 'theclinic' | 'exante' | 'interferencia' | 't13' | '13cl' | 'tvn' | '24horas' | 'mega' | 'meganoticias' | 'chilevision' | 'ojoalatele' | 'adprensa' | 'lahora' | 'emol' | 'generic';
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
