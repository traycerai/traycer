/**
 * The narrow historical-delivery retry contract. It deliberately carries no
 * answer or skip fields, so resolved cards cannot enter the live interview
 * submission path.
 */
export interface InterviewDeliveryRetryAction {
  readonly isPending: (input: {
    readonly blockId: string;
    readonly settlementId: string;
    readonly deliveryId: string;
    readonly generation: number;
  }) => boolean;
  readonly onRetry: (input: {
    readonly blockId: string;
    readonly settlementId: string;
    readonly deliveryId: string;
    readonly generation: number;
  }) => void;
}
