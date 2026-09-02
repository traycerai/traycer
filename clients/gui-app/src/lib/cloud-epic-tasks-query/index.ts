export { registerCloudEpicTasksClient } from "@/lib/cloud-epic-tasks-query/client-registry";
export {
  LIST_TASKS_LOCAL_FIRST_MINOR,
  negotiatedListTasksServesLocalFirst,
} from "@/lib/cloud-epic-tasks-query/local-first-admission";
export {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksFirstPageQueryOptions,
  cloudEpicTasksLastKnownQueryKey,
  cloudEpicTasksQueryKey,
  fetchCloudEpicTasksCursorPageByHostId,
  fetchCloudEpicTasksFirstPageByHostId,
  listCloudTasksRequestForHistorySearch,
  type ListCloudTasksRequest,
} from "@/lib/cloud-epic-tasks-query/query";
