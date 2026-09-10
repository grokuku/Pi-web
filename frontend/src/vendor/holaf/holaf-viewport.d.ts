// Déclarations TypeScript pour la brique HolafViewport (holaf-lib v0.1.3).
// Copie pinnée dans vendor/holaf — le fichier .js est du JS pur (sans types),
// on déclare ici l'API publique pour que tsc --noEmit passe sans `any` implicite.

export interface HolafViewportOptions {
  /** Mode de rendu : 'content' (la brique applique le transform) ou 'headless'. */
  mode?: "content" | "headless";
  /** Élément à transformer (mode content). Absent → headless. */
  content?: HTMLElement | null;
  /** Taille naturelle de l'image (ou setImageSize() ensuite). */
  imageWidth?: number;
  imageHeight?: number;
  /** 'fit' (défaut) = ne pas dézoomer sous le fit, ou nombre. */
  minZoom?: "fit" | number;
  maxZoom?: number;
  zoomFactor?: number;
  panClamp?: boolean;
  doubleClickZoom?: boolean;
  wheel?: boolean;
  drag?: boolean;
  dragButton?: number;
  dragTarget?: HTMLElement | null;
  /** Garde-fou par événement, consulté AVANT d'amorcer un drag. */
  canDrag?: (e: MouseEvent) => boolean;
  onChange?: (instance: HolafViewportInstance) => void;
}

export interface HolafViewportInstance {
  VERSION: string;
  setImageSize(w: number, h: number): void;
  fit(): void;
  getFitScale(): number;
  getScale(): number;
  getTransform(): { scale: number; tx: number; ty: number };
  zoomBy(factor: number, clientX?: number, clientY?: number): void;
  setScale(s: number, clientX?: number, clientY?: number): void;
  panBy(dx: number, dy: number): void;
  screenToImage(clientX: number, clientY: number): { x: number; y: number };
  imageToScreen(ix: number, iy: number): { x: number; y: number };
  getImageRect(): { x: number; y: number; width: number; height: number };
  on(cb: (instance: HolafViewportInstance) => void): HolafViewportInstance;
  off(cb: (instance: HolafViewportInstance) => void): HolafViewportInstance;
  addFollower(el: HTMLElement): HolafViewportInstance;
  removeFollower(el: HTMLElement): HolafViewportInstance;
  reset(): void;
  destroy(): void;
  refit(): void;
}

export const HolafViewport: {
  version: string;
  create(container: HTMLElement, opts?: HolafViewportOptions): HolafViewportInstance;
};
