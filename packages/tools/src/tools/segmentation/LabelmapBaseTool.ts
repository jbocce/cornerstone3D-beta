import {
  getEnabledElement,
  cache,
  utilities as csUtils,
  Enums,
  eventTarget,
  BaseVolumeViewport,
  volumeLoader,
} from '@cornerstonejs/core';
import type { Types } from '@cornerstonejs/core';

import { BaseTool } from '../base';
import type { LabelmapSegmentationDataVolume } from '../../types/LabelmapTypes';
import SegmentationRepresentations from '../../enums/SegmentationRepresentations';
import type vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import { getActiveSegmentation } from '../../stateManagement/segmentation/getActiveSegmentation';
import { getLockedSegmentIndices } from '../../stateManagement/segmentation/segmentLocking';
import { getSegmentation } from '../../stateManagement/segmentation/getSegmentation';
import { getClosestImageIdForStackViewport } from '../../utilities/annotationHydration';
import { getCurrentLabelmapImageIdForViewport } from '../../stateManagement/segmentation/getCurrentLabelmapImageIdForViewport';
import { getStackSegmentationImageIdsForViewport } from '../../stateManagement/segmentation/getStackSegmentationImageIdsForViewport';
import { getSegmentIndexColor } from '../../stateManagement/segmentation/config/segmentationColor';
import { getActiveSegmentIndex } from '../../stateManagement/segmentation/getActiveSegmentIndex';
import { StrategyCallbacks } from '../../enums';
import * as LabelmapMemo from '../../utilities/segmentation/createLabelmapMemo';

/**
 * A type for preview data/information, used to setup previews on hover, or
 * maintain the preview information.
 */
export type PreviewData = {
  /**
   *  The preview data returned from the strategy
   */
  preview: unknown;
  /** A timer id to allow cancelling the timer */
  timer?: number;
  /** The start time for the timer, to allow showing preview after a given length of time */
  timerStart: number;
  /**
   * The starting point where the use clicked down on, used to cancel preview
   * on drag, but preserve it if the user moves the mouse tiny amounts accidentally.
   */
  startPoint: Types.Point2;
  element: HTMLDivElement;
  /**
   * Record if this is a drag preview, that is, a preview which is being extended
   * by the user dragging to view more area.
   */
  isDrag: boolean;
};

/**
 * Labelmap tool containing shared functionality for labelmap tools.
 */
export default class LabelmapBaseTool extends BaseTool {
  protected _editData: {
    override: {
      voxelManager: Types.IVoxelManager<number>;
      imageData: vtkImageData;
    };
    segmentsLocked: number[]; //
    imageId?: string; // stack labelmap
    imageIds?: string[]; // stack labelmap
    volumeId?: string; // volume labelmap
    referencedVolumeId?: string;
  } | null;
  protected _hoverData?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    brushCursor: any;
    segmentationId: string;
    segmentIndex: number;
    segmentColor: [number, number, number, number];
    viewportIdsToRender: string[];
    centerCanvas?: Array<number>;
    viewport: Types.IViewport;
  };

  protected _previewData?: PreviewData = {
    preview: null,
    element: null,
    timerStart: 0,
    timer: null,
    startPoint: [NaN, NaN],
    isDrag: false,
  };

  constructor(toolProps, defaultToolProps) {
    super(toolProps, defaultToolProps);
  }

  /**
   * Creates a labelmap memo instance, which is a partially created memo
   * object that stores the changes made to the labelmap rather than the
   * initial state.  This memo is then committed once done so that the
   */
  public createMemo(segmentId: string, segmentationVoxelManager, preview) {
    this.memo ||= LabelmapMemo.createLabelmapMemo(
      segmentId,
      segmentationVoxelManager,
      preview
    );
    return this.memo as LabelmapMemo.LabelmapMemo;
  }

  createEditData(element) {
    const enabledElement = getEnabledElement(element);
    const { viewport } = enabledElement;

    const activeSegmentation = getActiveSegmentation(viewport.id);
    if (!activeSegmentation) {
      const event = new CustomEvent(Enums.Events.ERROR_EVENT, {
        detail: {
          type: 'Segmentation',
          message:
            'No active segmentation detected, create a segmentation representation before using the brush tool',
        },
        cancelable: true,
      });
      eventTarget.dispatchEvent(event);
      return null;
    }

    const { segmentationId } = activeSegmentation;

    const segmentsLocked = getLockedSegmentIndices(segmentationId);

    const { representationData } = getSegmentation(segmentationId);

    if (viewport instanceof BaseVolumeViewport) {
      const { volumeId } = representationData[
        SegmentationRepresentations.Labelmap
      ] as LabelmapSegmentationDataVolume;
      const actors = viewport.getActors();

      const isStackViewport =
        viewport instanceof getClosestImageIdForStackViewport;

      if (isStackViewport) {
        const event = new CustomEvent(Enums.Events.ERROR_EVENT, {
          detail: {
            type: 'Segmentation',
            message: 'Cannot perform brush operation on the selected viewport',
          },
          cancelable: true,
        });
        eventTarget.dispatchEvent(event);
        return null;
      }

      // we used to take the first actor here but we should take the one that is
      // probably the same size as the segmentation volume
      const volumes = actors.map((actorEntry) =>
        cache.getVolume(actorEntry.referencedId)
      );

      const segmentationVolume = cache.getVolume(volumeId);

      const referencedVolumeIdToThreshold =
        volumes.find((volume) =>
          csUtils.isEqual(volume.dimensions, segmentationVolume.dimensions)
        )?.volumeId || volumes[0]?.volumeId;

      return {
        volumeId,
        referencedVolumeId:
          this.configuration.thresholdVolumeId ?? referencedVolumeIdToThreshold,
        segmentsLocked,
      };
    } else {
      const segmentationImageId = getCurrentLabelmapImageIdForViewport(
        viewport.id,
        segmentationId
      );

      if (!segmentationImageId) {
        // if there is no stack segmentation slice for the current image
        // we should not allow the user to perform any operation
        return;
      }

      // I hate this, but what can you do sometimes
      if (this.configuration.activeStrategy.includes('SPHERE')) {
        const referencedImageIds = viewport.getImageIds();
        const isValidVolumeForSphere =
          csUtils.isValidVolume(referencedImageIds);

        if (!isValidVolumeForSphere) {
          throw new Error(
            'Volume is not reconstructable for sphere manipulation'
          );
        }

        const volumeId = `${segmentationId}_${viewport.id}`;
        const volume = cache.getVolume(volumeId);
        if (volume) {
          return {
            imageId: segmentationImageId,
            segmentsLocked,
            override: {
              voxelManager: volume.voxelManager,
              imageData: volume.imageData,
            },
          };
        } else {
          const labelmapImageIds = getStackSegmentationImageIdsForViewport(
            viewport.id,
            segmentationId
          );

          if (!labelmapImageIds || labelmapImageIds.length === 1) {
            return {
              imageId: segmentationImageId,
              segmentsLocked,
            };
          }

          // it will return the cached volume if it already exists
          const volume = volumeLoader.createAndCacheVolumeFromImagesSync(
            volumeId,
            labelmapImageIds
          );

          return {
            imageId: segmentationImageId,
            segmentsLocked,
            override: {
              voxelManager: volume.voxelManager,
              imageData: volume.imageData,
            },
          };
        }
      } else {
        return {
          imageId: segmentationImageId,
          segmentsLocked,
        };
      }
    }
  }

  protected createHoverData(element, centerCanvas?) {
    const enabledElement = getEnabledElement(element);
    const { viewport } = enabledElement;

    const camera = viewport.getCamera();
    const { viewPlaneNormal, viewUp } = camera;

    const viewportIdsToRender = [viewport.id];

    const { segmentIndex, segmentationId, segmentColor } =
      this.getActiveSegmentationData(viewport) || {};

    // Center of circle in canvas Coordinates
    const brushCursor = {
      metadata: {
        viewPlaneNormal: <Types.Point3>[...viewPlaneNormal],
        viewUp: <Types.Point3>[...viewUp],
        FrameOfReferenceUID: viewport.getFrameOfReferenceUID(),
        referencedImageId: '',
        toolName: this.getToolName(),
        segmentColor,
      },
      data: {},
    };

    return {
      brushCursor,
      centerCanvas,
      segmentIndex,
      viewport,
      segmentationId,
      segmentColor,
      viewportIdsToRender,
    };
  }

  protected getActiveSegmentationData(viewport) {
    const viewportId = viewport.id;
    const activeRepresentation = getActiveSegmentation(viewportId);

    if (!activeRepresentation) {
      return;
    }

    const { segmentationId } = activeRepresentation;
    const segmentIndex = getActiveSegmentIndex(segmentationId);

    if (!segmentIndex) {
      return;
    }

    const segmentColor = getSegmentIndexColor(
      viewportId,
      segmentationId,
      segmentIndex
    );

    return {
      segmentIndex,
      segmentationId,
      segmentColor,
    };
  }

  protected getOperationData(element?) {
    const editData = this._editData || this.createEditData(element);
    const { segmentIndex, segmentationId, brushCursor } =
      this._hoverData || this.createHoverData(element);
    const { data, metadata = {} } = brushCursor || {};
    const { viewPlaneNormal, viewUp } = metadata;
    const operationData = {
      ...editData,
      points: data?.handles?.points,
      segmentIndex,
      previewColors:
        this.configuration.preview?.enabled || this._previewData.preview
          ? this.configuration.preview.previewColors
          : null,
      viewPlaneNormal,
      toolGroupId: this.toolGroupId,
      segmentationId,
      viewUp,
      strategySpecificConfiguration:
        this.configuration.strategySpecificConfiguration,
      // Provide the preview information so that data can be used directly
      preview: this._previewData?.preview,
      createMemo: this.createMemo.bind(this),
    };
    return operationData;
  }

  /**
   * Adds a preview that can be filled with data.
   */
  public addPreview(
    element = this._previewData.element,
    options?: { acceptReject: boolean }
  ) {
    const acceptReject = options?.acceptReject;
    if (acceptReject === true) {
      this.acceptPreview(element);
    } else if (acceptReject === false) {
      this.rejectPreview(element);
    }
    const enabledElement = getEnabledElement(element);
    this._previewData.preview = this.applyActiveStrategyCallback(
      enabledElement,
      this.getOperationData(element),
      StrategyCallbacks.AddPreview
    );
    this._previewData.isDrag = true;
    return this._previewData.preview;
  }

  /**
   * Cancels any preview view being shown, resetting any segments being shown.
   */
  public rejectPreview(element = this._previewData.element) {
    if (!element || !this._previewData.preview) {
      return;
    }
    const enabledElement = getEnabledElement(element);
    this.applyActiveStrategyCallback(
      enabledElement,
      this.getOperationData(element),
      StrategyCallbacks.RejectPreview
    );
    this._previewData.preview = null;
    this._previewData.isDrag = false;
  }

  /**
   * Accepts a preview, marking it as the active segment.
   */
  public acceptPreview(element = this._previewData.element) {
    if (!element) {
      return;
    }

    this.doneEditMemo();

    const enabledElement = getEnabledElement(element);

    this.applyActiveStrategyCallback(
      enabledElement,
      this.getOperationData(element),
      StrategyCallbacks.AcceptPreview
    );
    this._previewData.isDrag = false;
    this._previewData.preview = null;
    // Store the edit memo too
    this.doneEditMemo();
  }
}
