client specific requirements : 

1) saperate dashborad for restaurant owner and restaurant employee 
2) add the menu shared here into the db
[1/12/2025, 5:26 pm] Suraj Zomato Hyderabad: https://drive.google.com/drive/folders/1e0CcttefSR0zjjyw1U8t2nrv4fWsNyNE?usp=drive_link
[4/12/2025, 11:14 am] Suraj Zomato Hyderabad: https://drive.google.com/drive/folders/1ij8NWQLsEnNSb9bnegIwSflSv17J6FcB

[text](../../../AppData/Local/Packages/5319275A.WhatsAppDesktop_cv1g1gvanyjgm/LocalState/sessions/87E20CDF199F7EAE31C12362EEFD5D5476DACBAB/transfers/2026-32/MANDUVA_MENU-1.xlsx)

3) update the welcome message for the restaurant. 

4) every order token number should be on daily basis not continuation. every day starts with order 1.

5) if order is received (payment don by customer) but item is finished in the kitchen, the employee should esaily go to hte chat and text him, propose him available items ask for replacement of item or refund of money, (automatic refund from razorpay)
Restaurant employee dashboard requrirements : 
orders, chats, menu, appliction settings tabs. 

Tabs Wise details : 

1) orders tab : 
1.1) implement search in orders based on customer name/order id/type(delivery, walkin)
1.2) only 3 states for every orders (current orders, dispatched, delivered)
    1.2.1) all fresh orders fall into current orders tab 
    1.2.2) after fresh order is received then accept button appears, after clicking it dispatch button appears which starts the delivery service to fetch riders, after rider picksup ,automatically shifted to dispatched, then after delivered automatically shifted to delivered
    1.2.3) put reject/refund option instead of cancel order
1.3) keep the order  neat and in detail without cluttered UI, also keep the cancel order buttion in a menu option so that the employee does not click it by mistake, also aks for confirmation before cancelling. implement automated refund after cancelling the order. 
1.4) add more options like jump to customer chat window from the order. split up the details nealty the delivery charge + order value in the order. ensure the tracking link shown is properly working  

2) chats tab : 
2.1) show human handoff chats saperately. or some filter to easily resolve the issues for customer. 
2.2) implement search here as well for easy navigation

3) Menu tab : 
3.1) add the latest manu items available in the Manduva menu excel sheet
3.2) remove the add items section from the menu tab, remove edit delete menu items., employee only toggle on/off each menu item, a toggle button would be better 
3.3) no options for the employee to make any changes in the menu except toggle on/off item based on availaility

4) application settings tab :
4.1) implement settings for dark theme and light theme
4.2) order notification audio selection


Restaurant Owner Dashboard requirements : 

1) per day full statistics 
2) issues from the customers
3) campaigs (for now by default all the customers), messages like restaurant is open now, we are ready to take your orders, we will be closing soon etc. 
4) cost split up. total delivery fees and order value saerately per day/selected week/ per month selected month
5) chats section to see all the customer chats if any human handoff issue is yet to be resolved. if issue is resolved display resolved by the employee.
6) customer manangement, filtering customers by orders/values/etc here we can add, edit, delete customers, and also add them to a campaign.
7) campaigns section, to manage different campaigns, add media to the campaign message etc
8) settings tab similar to current settings, with payment settings, restaurant metadata, emergency number (for sending alrets/issues raised by customer)
 